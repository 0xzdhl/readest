import { Effect, Layer } from 'effect';
import type { Md5Input } from './core';
import { Md5hash } from './service';

export const Md5HashBrowserLive = Layer.succeed(
  Md5hash,
  Md5hash.of({
    md5: (input) => Effect.succeed(pureMd5(input)),
    partialMd5: (file) =>
      Effect.promise(async () => {
        const step = 1024;
        const size = 1024;
        const chunks: Uint8Array[] = [];
        let totalLength = 0;

        for (let i = -1; i <= 10; i++) {
          const start = Math.min(file.size, step << (2 * i));
          const end = Math.min(start + size, file.size);

          if (start >= file.size) break;

          const bytes = new Uint8Array(await file.slice(start, end).arrayBuffer());
          chunks.push(bytes);
          totalLength += bytes.length;
        }

        const sampled = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of chunks) {
          sampled.set(chunk, offset);
          offset += chunk.length;
        }

        return pureMd5(sampled);
      }),
    md5Fingerprint: (value) =>
      Effect.sync(() => {
        return pureMd5(value).slice(0, 7);
      }),
  }),
);

function toBytes(value: Md5Input): Uint8Array {
  if (typeof value === 'string') return new TextEncoder().encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return Uint8Array.from(value);
}

const add = (x: number, y: number) => (x + y) | 0;
const rotateLeft = (value: number, bits: number) => (value << bits) | (value >>> (32 - bits));
const round = (q: number, a: number, b: number, x: number, s: number, t: number) =>
  add(rotateLeft(add(add(a, q), add(x, t)), s), b);
const ff = (a: number, b: number, c: number, d: number, x: number, s: number, t: number) =>
  round((b & c) | (~b & d), a, b, x, s, t);
const gg = (a: number, b: number, c: number, d: number, x: number, s: number, t: number) =>
  round((b & d) | (c & ~d), a, b, x, s, t);
const hh = (a: number, b: number, c: number, d: number, x: number, s: number, t: number) =>
  round(b ^ c ^ d, a, b, x, s, t);
const ii = (a: number, b: number, c: number, d: number, x: number, s: number, t: number) =>
  round(c ^ (b | ~d), a, b, x, s, t);

function toHexWord(value: number): string {
  let hex = '';
  for (let i = 0; i < 4; i++) {
    hex += ((value >>> (i * 8)) & 0xff).toString(16).padStart(2, '0');
  }
  return hex;
}

function pureMd5(value: Md5Input) {
  const bytes = toBytes(value);
  const words = new Uint32Array((((bytes.length + 8) >>> 6) + 1) * 16);
  const bitLength = bytes.length * 8;

  const word = (index: number) => words[index] ?? 0;

  for (let i = 0; i < bytes.length; i++) {
    const index = i >>> 2;
    words[index] = word(index) | ((bytes[i] ?? 0) << ((i % 4) * 8));
  }
  const paddingIndex = bytes.length >>> 2;
  words[paddingIndex] = word(paddingIndex) | (0x80 << ((bytes.length % 4) * 8));
  words[words.length - 2] = bitLength & 0xffffffff;
  words[words.length - 1] = Math.floor(bitLength / 0x100000000);

  let a = 0x67452301;
  let b = 0xefcdab89;
  let c = 0x98badcfe;
  let d = 0x10325476;

  for (let i = 0; i < words.length; i += 16) {
    const oldA = a;
    const oldB = b;
    const oldC = c;
    const oldD = d;

    a = ff(a, b, c, d, word(i), 7, -680876936);
    d = ff(d, a, b, c, word(i + 1), 12, -389564586);
    c = ff(c, d, a, b, word(i + 2), 17, 606105819);
    b = ff(b, c, d, a, word(i + 3), 22, -1044525330);
    a = ff(a, b, c, d, word(i + 4), 7, -176418897);
    d = ff(d, a, b, c, word(i + 5), 12, 1200080426);
    c = ff(c, d, a, b, word(i + 6), 17, -1473231341);
    b = ff(b, c, d, a, word(i + 7), 22, -45705983);
    a = ff(a, b, c, d, word(i + 8), 7, 1770035416);
    d = ff(d, a, b, c, word(i + 9), 12, -1958414417);
    c = ff(c, d, a, b, word(i + 10), 17, -42063);
    b = ff(b, c, d, a, word(i + 11), 22, -1990404162);
    a = ff(a, b, c, d, word(i + 12), 7, 1804603682);
    d = ff(d, a, b, c, word(i + 13), 12, -40341101);
    c = ff(c, d, a, b, word(i + 14), 17, -1502002290);
    b = ff(b, c, d, a, word(i + 15), 22, 1236535329);

    a = gg(a, b, c, d, word(i + 1), 5, -165796510);
    d = gg(d, a, b, c, word(i + 6), 9, -1069501632);
    c = gg(c, d, a, b, word(i + 11), 14, 643717713);
    b = gg(b, c, d, a, word(i), 20, -373897302);
    a = gg(a, b, c, d, word(i + 5), 5, -701558691);
    d = gg(d, a, b, c, word(i + 10), 9, 38016083);
    c = gg(c, d, a, b, word(i + 15), 14, -660478335);
    b = gg(b, c, d, a, word(i + 4), 20, -405537848);
    a = gg(a, b, c, d, word(i + 9), 5, 568446438);
    d = gg(d, a, b, c, word(i + 14), 9, -1019803690);
    c = gg(c, d, a, b, word(i + 3), 14, -187363961);
    b = gg(b, c, d, a, word(i + 8), 20, 1163531501);
    a = gg(a, b, c, d, word(i + 13), 5, -1444681467);
    d = gg(d, a, b, c, word(i + 2), 9, -51403784);
    c = gg(c, d, a, b, word(i + 7), 14, 1735328473);
    b = gg(b, c, d, a, word(i + 12), 20, -1926607734);

    a = hh(a, b, c, d, word(i + 5), 4, -378558);
    d = hh(d, a, b, c, word(i + 8), 11, -2022574463);
    c = hh(c, d, a, b, word(i + 11), 16, 1839030562);
    b = hh(b, c, d, a, word(i + 14), 23, -35309556);
    a = hh(a, b, c, d, word(i + 1), 4, -1530992060);
    d = hh(d, a, b, c, word(i + 4), 11, 1272893353);
    c = hh(c, d, a, b, word(i + 7), 16, -155497632);
    b = hh(b, c, d, a, word(i + 10), 23, -1094730640);
    a = hh(a, b, c, d, word(i + 13), 4, 681279174);
    d = hh(d, a, b, c, word(i), 11, -358537222);
    c = hh(c, d, a, b, word(i + 3), 16, -722521979);
    b = hh(b, c, d, a, word(i + 6), 23, 76029189);
    a = hh(a, b, c, d, word(i + 9), 4, -640364487);
    d = hh(d, a, b, c, word(i + 12), 11, -421815835);
    c = hh(c, d, a, b, word(i + 15), 16, 530742520);
    b = hh(b, c, d, a, word(i + 2), 23, -995338651);

    a = ii(a, b, c, d, word(i), 6, -198630844);
    d = ii(d, a, b, c, word(i + 7), 10, 1126891415);
    c = ii(c, d, a, b, word(i + 14), 15, -1416354905);
    b = ii(b, c, d, a, word(i + 5), 21, -57434055);
    a = ii(a, b, c, d, word(i + 12), 6, 1700485571);
    d = ii(d, a, b, c, word(i + 3), 10, -1894986606);
    c = ii(c, d, a, b, word(i + 10), 15, -1051523);
    b = ii(b, c, d, a, word(i + 1), 21, -2054922799);
    a = ii(a, b, c, d, word(i + 8), 6, 1873313359);
    d = ii(d, a, b, c, word(i + 15), 10, -30611744);
    c = ii(c, d, a, b, word(i + 6), 15, -1560198380);
    b = ii(b, c, d, a, word(i + 13), 21, 1309151649);
    a = ii(a, b, c, d, word(i + 4), 6, -145523070);
    d = ii(d, a, b, c, word(i + 11), 10, -1120210379);
    c = ii(c, d, a, b, word(i + 2), 15, 718787259);
    b = ii(b, c, d, a, word(i + 9), 21, -343485551);

    a = add(a, oldA);
    b = add(b, oldB);
    c = add(c, oldC);
    d = add(d, oldD);
  }

  return [a, b, c, d].map(toHexWord).join('');
}
