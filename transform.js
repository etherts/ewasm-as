const NodeKind = require("assemblyscript").NodeKind
const parseFile = require("assemblyscript").parseFile
const keccak256 = require("js-sha3").keccak256

exports.afterParse = function (parser) {
  // Only consider entry source
  const entrySrc = parser.program.sources.find(s => s.isEntry)
  if (entrySrc) {
    // Make sure there's no existing main function
    const mainFn = entrySrc.statements.find(t =>
      t.kind === NodeKind.FUNCTIONDECLARATION && t.name.text === "main")
    if (mainFn) {
      throw new Error("Entry file cannot declare main function")
    }

    // Find contracts -- TODO: for now just the first
    const contractStmt = entrySrc.statements.find(t =>
      (t.kind === NodeKind.CLASSDECLARATION && t.decorators && t.decorators.length
      && t.decorators[0].name.text === "ewasm"))
    if (contractStmt) {
      const contractName = contractStmt.name.text
      let abiRouter = (
`export function main(): void {
  if (getCallDataSize() < 4)
    revert(0, 0)

  var ptrSelector = <i32>allocate_memory(4)
  callDataCopy(ptrSelector, 0, 4)
  var selector = load<i32>(ptrSelector)

  var contract = new ${contractName}()

  switch(selector) {
`)

      // Process the methods
      contractStmt.members.filter(m => m.kind === NodeKind.METHODDECLARATION).forEach(method => {
        // construct the ABI signature for this method
        var signature = ""
        signature += method.name.text
        signature += "("
        signature += method.signature.parameters.reduce(
          (acc, cur) => (acc ? acc + "," : "") + cur.type.name.text,
          ""
        )
        signature += ")"
        if (method.signature.returnType)
          signature += ":(" + method.signature.returnType.name.text + ")"
        const abssig = keccak256(signature).substring(0,4)
        console.log("Generated signature for method:", signature, ", abssig:", abssig)
        abiRouter += `case 0x${abssig}: contract.${method.name.text}(); break; `
      });

      abiRouter += 'default: revert(0, 0)}}'
      console.log("abiRouter:", abiRouter)
      const innerParser = parseFile(abiRouter, 'input.ts', true, null)
    }
  }
}

