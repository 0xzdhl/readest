export type Md5Input = string | ArrayBuffer | ArrayBufferView | number[];

export function toHashInput(value: Md5Input): string | Uint8Array {
  if (typeof value === 'string') return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return Uint8Array.from(value);
}
