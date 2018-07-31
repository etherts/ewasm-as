// Use assemblyscript distribution files if present, otherwise run the sources directly
const path = require('path')
var assemblyscript
(() => {
  try {
    assemblyscript = require('assemblyscript')
  } catch (e) {
    require('ts-node').register({ project: path.join(__dirname, '..', '..', 'node_modules', 'assemblyscript', 'src', 'tsconfig.json') })
    require('../../node_modules/assemblyscript/src/glue/js')
    assemblyscript = require('../../node_modules/assemblyscript/src')
  }
})()
const {
  CommonFlags,
  Node,
  NodeKind,
  SourceKind,
  TypeKind,
  parseFile
} = assemblyscript
const keccak256 = require('js-sha3').keccak256

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
  const entrySrc = parser.program.sources.find(s => s.isEntry)
  if (!entrySrc)
    throw new Error("Found no main entry source")

  // Make sure there's no existing main function
  const mainFn = entrySrc.statements.find(t =>
    t.kind === NodeKind.FUNCTIONDECLARATION && t.name.text === 'main')
  if (mainFn) {
    throw new Error('Entry file cannot declare main function')
  }

  // Find contracts -- TODO: for now just the first
  const contractStmt = entrySrc.statements.find(t =>
    (t.kind === NodeKind.CLASSDECLARATION && t.decorators && t.decorators.length &&
      t.decorators[0].name.text === 'ewasm'))
  if (contractStmt) {
    const contractName = contractStmt.name.text
    let abiRouter = (
      `export function main(): void {
        if (getCallDataSize() < 4)
          revert(0, 0)

        var ptrSelector = <i32>memory.allocate(4)
        callDataCopy(ptrSelector, 0, 4)
        var selector = load<i32>(ptrSelector)

        switch(selector) {
      `)

    // Process members: find stored mappings
    const storedMappings = contractStmt.members.filter(m =>
      m.kind === NodeKind.FIELDDECLARATION && m.decorators &&
      m.decorators.length && m.decorators[0].name.text === 'store' &&
      // TODO: can we use TypeKind here?
      m.type.name.text === 'Map'
    ).reduce(
      (acc, cur) => ({[cur.name.text]: cur.type.typeArguments, ...acc}), {}
    )

    // Process the methods; skip the constructor
    let abiFunction = ''
    contractStmt.members.filter(m =>
      m.kind === NodeKind.METHODDECLARATION && !m.is(CommonFlags.CONSTRUCTOR)
    ).forEach(method => {
      // Create an ABI wrapper function for this method to handle memory management
      // and decode the parameters

      // Loop over the params for these next steps
      let paramsWrapper = ''
      let methodSignature = ''
      let argList = ''
      // Start reading from fifth byte (selector, above, comes first)
      let currentPlace = 4
      let varNum = 0
      method.signature.parameters.forEach(p => {
        methodSignature += methodSignature ? ',' : ''
        methodSignature += p.type.name.text
        argList += argList ? ',' : ''
        // TODO: Why can't we match p.type.kind against TypeKind?
        switch (p.type.name.text) {
          case 'Address':
            paramsWrapper += (`
var ptrParam${varNum}:i32 = <i32>memory.allocate(20)
callDataCopy(ptrParam${varNum}, ${currentPlace}, 20)
`
            )
            currentPlace += 20
            argList += `ptrParam${varNum}`
            break
          case 'Amount':
            paramsWrapper += (`
var ptrParam${varNum}:i32 = <i32>memory.allocate(32)
callDataCopy(ptrParam${varNum}, ${currentPlace}, 32)
`
            )
            currentPlace += 32
            argList += `ptrParam${varNum}`
            break
          default:
            throw new Error('Unsupported type found in params: ' + p.type.name.text)
        }
        varNum++
      })

      abiFunction += (
        `
function ${method.name.text}_wrapper(): void {
var datasize:u32 = getCallDataSize()
if (datasize !== ${currentPlace})
  throw new Error("Bad call data length")
var contract = new ${contractName}()
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
finish(0, 0)
}
`
        )
      } else {
        returnSignature = `(${method.signature.returnType.name.text})`
        // TODO: Why can't we use returnType.kind?
        switch (method.signature.returnType.name.text) {
          case 'Amount':
            returnType = 'i32'
            returnsWrapper = (
              `
// Store return value
var ptrReturn = <i32>memory.allocate(32)
store<i32>(ptrReturn, retval)

// Call return
finish(ptrReturn, 32)
}
`
            )
            break
          default:
            throw new Error('Unsupported return type: ' + method.signature.returnType.name.text)
        }
        abiFunction += (
          `  // Call method with loaded args, capture return value
var retval:${returnType} = contract.${method.name.text}(${argList})
`
        ) + returnsWrapper
      }

      const signature = `${method.name.text}(${methodSignature})${returnSignature}`
      const abssig = keccak256(signature).substring(0, 8)
      console.log('Generated signature for method:', signature, ', abssig:', abssig)
      abiRouter += (
        `          case 0x${abssig}: ${method.name.text}_wrapper(); break
`
      )

      // Do one more thorough walk through the AST
      // For now, in practice, we just do a one level deep walk through
      // the statements in this method.
      // TODO: Do this properly.
      let newStatements = []
      method.body.statements.forEach(s => {
        // Map write
        if (s.kind && s.kind === NodeKind.EXPRESSION &&
          s.expression && s.expression.kind === NodeKind.BINARY &&
          s.expression.left && s.expression.left.kind === NodeKind.ELEMENTACCESS &&
          s.expression.left.expression && s.expression.left.expression.expression && s.expression.left.expression.expression.kind === NodeKind.THIS &&
          s.expression.left.expression.property && s.expression.left.expression.property.kind === NodeKind.IDENTIFIER &&
          storedMappings[s.expression.left.expression.property.text]) {
          console.log('Found write mapping expression')
          const mapName = s.expression.left.expression.property.text
          const keyExpr = s.expression.left.elementExpression
          const valExpr = s.expression.right
          const typeArguments = storedMappings[mapName]
          const typeKey = typeArguments[0].name.text
          const typeVal = typeArguments[1].name.text
          const storageWrapperFn = (
            `const storageWrapper = function(key:${typeKey}, val:${typeVal}):void {
  var ptrStorageVal:${typeVal} = <${typeVal}>memory.allocate(32)
  var ptrResult:usize = <i32>memory.allocate(32)
  var ptrInput:usize = <i32>memory.allocate(32)
  store<i32>(ptrInput, '${mapName}') // + key)
  keccak256Wrapper(ptrInput, 32, ptrResult)
  store<${typeVal}>(ptrStorageVal, val)
  storageStore(ptrResult, ptrStorageVal)
}
`
          )
          const storageWrapperFnDefinitionStatement = parseFile(
            storageWrapperFn,
            entrySrc.range.source.normalizedPath, true, null).program.sources[0].statements[0]
          const callWrapperStatement = parseFile(
            `storageWrapper()`, entrySrc.range.source.normalizedPath, true, null).program.sources[0].statements[0]

          // Perform some surgery
          callWrapperStatement.expression.arguments.push(keyExpr, valExpr)
          newStatements.push(storageWrapperFnDefinitionStatement)
          newStatements.push(callWrapperStatement)
        }
        // Map read
        else if (s.value && s.value.kind === NodeKind.ELEMENTACCESS &&
          s.value.expression && s.value.expression.kind === NodeKind.PROPERTYACCESS &&
          s.value.expression.expression && s.value.expression.expression.kind === NodeKind.THIS &&
          s.value.expression.property && s.value.expression.property.kind === NodeKind.IDENTIFIER &&
          storedMappings[s.value.expression.property.text]) {
          console.log('Found read mapping expression')
          // Replace the value with a storage read
          const mapName = s.value.expression.property.text
          const keyExpr = s.value.elementExpression
          const typeArguments = storedMappings[mapName]

          // Rewrite the read to a storage read
          // TODO: Fix the sizes here, should not all be hardcoded to 32
          const typeKey = typeArguments[0].name.text
          const typeToLoad = typeArguments[1].name.text
          const storageLoadWrapperFn = (
            `const storageLoadWrapper = function(key:${typeKey}):${typeToLoad} {
  var ptrStorageVal:${typeToLoad} = <${typeToLoad}>memory.allocate(32)
  var ptrResult:usize = <i32>memory.allocate(32)
  var ptrInput:usize = <i32>memory.allocate(32)
  store<i32>(ptrInput, '${mapName}') // + key)
  keccak256Wrapper(ptrInput, 32, ptrResult)
  storageLoad(ptrResult, ptrStorageVal)
  return load<${typeToLoad}>(ptrStorageVal)
}
`
          )
          const storageLoadWrapperFnDefinitionStatement = parseFile(
            storageLoadWrapperFn,
            entrySrc.range.source.normalizedPath, true, null).program.sources[0].statements[0]
          const callWrapperStatement = parseFile(
            `storageLoadWrapper()`, entrySrc.range.source.normalizedPath, true, null).program.sources[0].statements[0]

          // Perform some surgery
          callWrapperStatement.expression.arguments.push(keyExpr)
          newStatements.push(storageLoadWrapperFnDefinitionStatement)
          s.value = callWrapperStatement.expression
          newStatements.push(s)
        } else {
          newStatements.push(s)
        }
      })
      method.body.statements = newStatements
    })

    abiRouter += (
      `    default: revert(0, 0)
}
}
`
    )
    abiRouter = abiFunction + abiRouter
    console.log('abiRouter:', abiRouter)

    // Parse the complete ABI router method
    // Note that the "filename" here must match the existing source filename
    // so that these statements are embedded in that file for compiling and
    // linking; otherwise resolving will fail.
    const innerParser = parseFile(abiRouter, entrySrc.range.source.normalizedPath, true, null)
    const routerStatements = innerParser.program.sources[0].statements
    // routerStatement.parent = mainSource
    entrySrc.statements.push(...routerStatements)
  }
}
