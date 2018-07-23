// Ewasm-AssemblyScript API
// Author: Lane Rettig <lane@cryptonyc.org>

export class Address {
  constructor(
    public Address: i32,
  ) {}
}

export class Contract {
  // Required for now per https://github.com/AssemblyScript/assemblyscript/issues/167
  constructor() {}
  init(): Address { return new Address(0) }
}

export function read<T>(name: string): T { return load<T>(0) }
export function write<T>(name: string, value: T): void {}

export function assert(premise: bool): bool {
  if (!premise)
    throw new Error("Assertion failure")
}
