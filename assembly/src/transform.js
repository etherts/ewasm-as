// Use assemblyscript distribution files if present, otherwise run the sources directly
const path = require("path")
var assemblyscript
(() => {
  try {
    assemblyscript = require("assemblyscript")
  } catch (e) {
    require("ts-node").register({ project: path.join(__dirname, "..", "..", "node_modules", "assemblyscript", "src", "tsconfig.json") })
    require("../../node_modules/assemblyscript/src/glue/js")
    assemblyscript = require("../../node_modules/assemblyscript/src")
  }
})()
const { NodeKind, SourceKind, parseFile } = assemblyscript
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

  var ptrSelector = <i32>memory.allocate(4)
  callDataCopy(ptrSelector, 0, 4)
  var selector = load<i32>(ptrSelector)

  var contract = new ${contractName}()

  switch(selector) {
`)

      // Process the methods
      contractStmt.members.filter(m => m.kind === NodeKind.METHODDECLARATION).forEach(method => {
        // Create a wrapper function for this method to handle memory management

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
        const abssig = keccak256(signature).substring(0,8)
        console.log("Generated signature for method:", signature, ", abssig:", abssig)
        abiRouter += `case 0x${abssig}: contract.${method.name.text}(); break; `
      });

      abiRouter += 'default: revert(0, 0)}}'
      console.log("abiRouter:", abiRouter)

      // Find the right source
      const mainSource = parser.program.sources.find(s => s.sourceKind === SourceKind.ENTRY)

      // Insert it into the program AST
      if (mainSource) {
        // Parse the complete ABI router method
        // Note that the "filename" here must match the existing source filename
        // so that these statements are embedded in that file for compiling and
        // linking; otherwise resolving will fail.
        const innerParser = parseFile(abiRouter, mainSource.range.source.normalizedPath, true, null)
        const routerStatement = innerParser.program.sources[0].statements[0]
        routerStatement.parent = mainSource
        mainSource.statements.push(routerStatement)
      }
      else
        throw new Error("Found no main source")
      true
    }
  }
}
