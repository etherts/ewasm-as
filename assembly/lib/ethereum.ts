// This file sets up functions provided by the VM for use with AssemblyScript

import "allocator/arena";

// Import some from binary
// const fs = require("fs");
// const compiled = new WebAssembly.Module(fs.readFileSync(__dirname + "/keccak.wasm"));
// const imports = {};
export function keccak256Wrapper(dataOffset: i32, length: i32, resultOffset: i32): void {
    keccak256(32808, dataOffset, length, resultOffset);
}

export declare function keccak256(contextOffset: i32, dataOffset: i32, length: i32, resultOffset: i32): void;

@external("return")
export declare function finish(dataOffset: i32, length: i32): void;

export declare function revert(dataOffset: i32, length: i32): void;

export declare function callDataCopy(resultOffset: i32, dataOffset: i32, length: i32): void;

export declare function getCallDataSize(): i32;

export declare function getCaller(dataOffset: i32): void;

export declare function storageStore(pathOffset: i32, valueOffset: i32): void;

export declare function storageLoad(pathOffset: i32, resultOffset: i32): void;

@external("debug", "printMemHex")
export declare function printMemHex(dataOffset: i32, length: i32): void;

export declare type Address = i32;
export declare type Amount = i32;
