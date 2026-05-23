import { Effect } from 'effect';
import type { Md5Input } from '@/libs/crypto/md5/core';
import { Md5HashLayer } from '@/libs/crypto/md5/layer';
import { Md5hash } from '@/libs/crypto/md5/service';

// Wrap effect, because md5 utils are pure functions we could invoke Effect.run* safely
export const md5 = (input: Md5Input) =>
  Effect.runSync(
    Md5hash.pipe(
      Effect.flatMap((s) => s.md5(input)),
      Effect.provide(Md5HashLayer),
    ),
  );

export const md5Fingerprint = (value: string) =>
  Effect.runSync(
    Md5hash.pipe(
      Effect.flatMap((s) => s.md5Fingerprint(value)),
      Effect.provide(Md5HashLayer),
    ),
  );

export const partialMd5 = (file: File) =>
  Effect.runPromise(
    Md5hash.pipe(
      Effect.flatMap((s) => s.partialMd5(file)),
      Effect.provide(Md5HashLayer),
    ),
  );

export function isMd5(value: string): boolean {
  return /^[0-9a-f]{32}$/.test(value);
}
