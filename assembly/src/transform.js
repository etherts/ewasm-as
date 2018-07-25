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
const {
  CommonFlags,
  NodeKind,
  SourceKind,
  TypeFlags,
  TypeKind,
  parseFile,
} = assemblyscript
const keccak256 = require("js-sha3").keccak256

/**
 * This function implements a basic, bare-bones ABI as a proof of concept
 * based on the simplistic ABI laid out here:
 * https://gist.github.com/axic/16158c5c88fbc7b1d09dfa8c658bc363
 *
 * TODO: Transition to full ABI support using
 https://github.com/ethereumjs/ethereumjs-abi (or web3.js, ethjs-abi,
 etherjs-abi libraries per @axic)
 */
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

      // Process the methods; skip the constructor
      let abiFunction = ""
      contractStmt.members.filter(m =>
        m.kind === NodeKind.METHODDECLARATION && !m.is(CommonFlags.CONSTRUCTOR)
      ).forEach(method => {
        // Create an ABI wrapper function for this method to handle memory management
        // and decode the parameters

        // Loop over the params for these next steps
        let paramsWrapper = ""
        let methodSignature = ""
        let argList = ""
        // Start reading from fifth byte (selector, above, comes first)
        let currentPlace = 4
        let varNum = 0
        method.signature.parameters.forEach(p => {
          methodSignature += methodSignature ? "," : ""
          methodSignature += p.type.name.text
          argList += argList ? "," : ""
          // TODO: How to handle Address? What kind and name does it have?
          switch (p.type.kind) {
            case TypeKind.I16:
              paramsWrapper += (`
  var ptrParam${varNum} = <i32>memory.allocate(20)
  callDataCopy(ptr${varNum}, ${currentPlace}, 20)
`
              )
              currentPlace += 20
              argList += `ptr${varNum}`
              break
            default:
              throw new Error("Unsupported type found in params")
          }
          varNum++
        })

        abiFunction += (
          `
function ${method.name.text}_wrapper(): void {
  var datasize:u32 = getCallDataSize()
  if (datasize !== ${currentPlace})
    throw new Error("Bad call data length")
   ${paramsWrapper}
`
        )
        // Handle method return vals
        let returnsWrapper = ''
        let returnType
        let returnSignature = ''
        // TODO: for some reason kind !== TypeKind.VOID
        if (method.signature.returnType.name.text === 'void') {
          abiFunction += (
            `  // Call method with loaded args, no return value
  contract.${method.name.text}(${argList})
  return(0, 0)
}
`
          )
        } else {
          returnSignature = `(${method.signature.returnType.name.text})`
          switch (method.signature.returnType.kind) {
            case TypeKind.I16:
              returnType = 'i16'
              returnsWrapper = (
                `
  // Store return value
  var ptrReturn = <i32>memory.allocate(32)
  store<i32>(ptrReturn, retval)

  // Call return
  return(ptrReturn, 32)
}
`
              )
              break
            default:
              throw new Error("Unsupported return type: " + method.signature.returnType.name.text)
          }
          abiFunction += (
            `  // Call method with loaded args, capture return value
  var retval:${returnType} = contract.${method.name.text}(${argList})
`
          ) + returnsWrapper
        }

        const signature = `${method.name.text}(${methodSignature})${returnSignature}`
        const abssig = keccak256(signature).substring(0,8)
        console.log("Generated signature for method:", signature, ", abssig:", abssig)
        abiRouter += (
          `    case 0x${abssig}: ${method.name.text}_wrapper(); break
`
        )
      });

      abiRouter += (
        `    default: revert(0, 0)
  }
}
`
      )
      abiRouter = abiFunction + abiRouter
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
    }
  }
}
