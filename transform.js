import { NodeKind } from "assemblyscript/src/ast"
import { parseFile } from "assemblyscript/src"
import { keccak256 } from "js-sha3"

export function afterParse (parser) {
  // Create a placeholder "main" function as a starting point
  const innerParser = parseFile('export function main(): void {}', 'input.ts', true, null);

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
      // Process the methods
      for (const method of contractStmt.members.filter(m => m.kind === NodeKind.METHODDECLARATION)) {
        // construct the signature
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
        console.log("Generated signature for method:", signature)
        // console.log("Keccak:", keccak256(signature))
        const abssig = keccak256(signature).substring(0,4)
        console.log("abssig:", abssig)
      }

      // Add main export function as ABI wrapper
    }
  }
}
