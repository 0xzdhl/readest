import { Context, type Effect } from 'effect';
import type { Md5Input } from './core';

export class Md5hash extends Context.Tag('Md5hash')<
  Md5hash,
  {
    readonly md5: (input: Md5Input) => Effect.Effect<string>;
    readonly partialMd5: (file: File) => Effect.Effect<string>;
    readonly md5Fingerprint: (value: string) => Effect.Effect<string>;
  }
>() {}
