import JSBI from "jsbi";

type JSBIValue = ReturnType<typeof JSBI.BigInt>;

function toJSBI(value: unknown): JSBIValue {
  return value instanceof JSBI
    ? value
    : JSBI.BigInt(value as string | number | boolean);
}

function createBigIntArrayClass(signed: boolean, tag: string) {
  return class BigIntArrayCompat implements Iterable<JSBIValue> {
    static readonly BYTES_PER_ELEMENT = 8;
    readonly BYTES_PER_ELEMENT = 8;
    readonly buffer: ArrayBuffer;
    readonly byteOffset: number;
    readonly byteLength: number;
    readonly length: number;

    constructor(source: number | ArrayBuffer | ArrayLike<unknown> = 0, byteOffset = 0, length?: number) {
      if (source instanceof ArrayBuffer) {
        if (byteOffset % 8 !== 0) throw new RangeError("start offset must be a multiple of 8");
        const available = source.byteLength - byteOffset;
        const resolvedLength = length ?? available / 8;
        if (!Number.isInteger(resolvedLength) || resolvedLength < 0 || resolvedLength * 8 > available) {
          throw new RangeError("invalid BigInt typed array length");
        }
        this.buffer = source;
        this.byteOffset = byteOffset;
        this.length = resolvedLength;
      } else {
        const values = typeof source === "number" ? null : Array.from(source as ArrayLike<unknown>);
        const resolvedLength = values ? values.length : (source as number);
        if (!Number.isInteger(resolvedLength) || resolvedLength < 0) {
          throw new RangeError("invalid BigInt typed array length");
        }
        this.buffer = new ArrayBuffer(resolvedLength * 8);
        this.byteOffset = 0;
        this.length = resolvedLength;
        if (values) values.forEach((value, index) => this.write(index, value));
      }

      this.byteLength = this.length * 8;
      for (let index = 0; index < this.length; index++) {
        Object.defineProperty(this, index, {
          configurable: false,
          enumerable: true,
          get: () => this.read(index),
          set: (value: unknown) => this.write(index, value),
        });
      }
    }

    private read(index: number): JSBIValue {
      if (index < 0 || index >= this.length) return undefined as unknown as JSBIValue;
      const bytes = new Uint8Array(this.buffer, this.byteOffset + index * 8, 8);
      let value = JSBI.BigInt(0);
      for (let byte = 7; byte >= 0; byte--) {
        value = JSBI.add(JSBI.leftShift(value, JSBI.BigInt(8)), JSBI.BigInt(bytes[byte]));
      }
      return signed ? JSBI.asIntN(64, value) : value;
    }

    private write(index: number, input: unknown): void {
      if (index < 0 || index >= this.length) return;
      let value = JSBI.asUintN(64, toJSBI(input));
      const bytes = new Uint8Array(this.buffer, this.byteOffset + index * 8, 8);
      const mask = JSBI.BigInt(255);
      for (let byte = 0; byte < 8; byte++) {
        bytes[byte] = JSBI.toNumber(JSBI.bitwiseAnd(value, mask));
        value = JSBI.signedRightShift(value, JSBI.BigInt(8));
      }
    }

    at(index: number): JSBIValue | undefined {
      const resolved = index < 0 ? this.length + index : index;
      return resolved < 0 || resolved >= this.length ? undefined : this.read(resolved);
    }

    set(values: ArrayLike<unknown>, offset = 0): void {
      if (offset < 0 || offset + values.length > this.length) throw new RangeError("offset is out of bounds");
      for (let index = 0; index < values.length; index++) this.write(offset + index, values[index]);
    }

    subarray(begin = 0, end = this.length): BigIntArrayCompat {
      const start = Math.max(0, begin < 0 ? this.length + begin : begin);
      const finish = Math.max(start, Math.min(this.length, end < 0 ? this.length + end : end));
      return new (this.constructor as typeof BigIntArrayCompat)(this.buffer, this.byteOffset + start * 8, finish - start);
    }

    *values(): IterableIterator<JSBIValue> {
      for (let index = 0; index < this.length; index++) yield this.read(index);
    }

    *keys(): IterableIterator<number> {
      for (let index = 0; index < this.length; index++) yield index;
    }

    *entries(): IterableIterator<[number, JSBIValue]> {
      for (let index = 0; index < this.length; index++) yield [index, this.read(index)];
    }

    forEach(callback: (value: JSBIValue, index: number, array: BigIntArrayCompat) => void, thisArg?: unknown): void {
      for (let index = 0; index < this.length; index++) callback.call(thisArg, this.read(index), index, this);
    }

    [Symbol.iterator](): IterableIterator<JSBIValue> {
      return this.values();
    }

    get [Symbol.toStringTag](): string {
      return tag;
    }
  };
}

export function installBigIntTypedArrays(): void {
  if (!("BigUint64Array" in globalThis)) {
    Object.defineProperty(globalThis, "BigUint64Array", {
      configurable: true,
      value: createBigIntArrayClass(false, "BigUint64Array"),
      writable: true,
    });
  }
  if (!("BigInt64Array" in globalThis)) {
    Object.defineProperty(globalThis, "BigInt64Array", {
      configurable: true,
      value: createBigIntArrayClass(true, "BigInt64Array"),
      writable: true,
    });
  }
}
