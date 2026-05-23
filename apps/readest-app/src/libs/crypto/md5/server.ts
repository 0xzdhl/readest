import { Effect, Layer } from 'effect';
import { type Md5Input, toHashInput } from './core';
import { Md5hash } from './service';

export const Md5HashServerLive = Layer.succeed(
  Md5hash,
  Md5hash.of({
    md5: (input) =>
      Effect.sync(() => {
        //  prevent static AST analysis
        const { createHash } = require('node:crypto');
        return createHash('md5').update(toHashInput(input)).digest('hex');
      }),
    partialMd5: (file) =>
      Effect.promise(async () => {
        const { createHash } = require('node:crypto');

        const step = 1024;
        const size = 1024;
        const hasher = createHash('md5');

        for (let i = -1; i <= 10; i++) {
          const start = Math.min(file.size, step << (2 * i));
          const end = Math.min(start + size, file.size);

          if (start >= file.size) break;

          const blobSlice = file.slice(start, end);
          const arrayBuffer = await blobSlice.arrayBuffer();
          const uint8Array = new Uint8Array(arrayBuffer);

          hasher.update(uint8Array);
        }

        return hasher.digest('hex');
      }),
    md5Fingerprint: (value) =>
      Effect.sync(() => {
        const { createHash } = require('node:crypto');
        const md5Fn = (input: Md5Input) =>
          createHash('md5').update(toHashInput(input)).digest('hex');

        return md5Fn(value).slice(0, 7);
      }),
  }),
);
