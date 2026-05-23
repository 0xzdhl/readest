import { Effect, type Layer } from 'effect';
import { Md5HashBrowserLive } from '@/libs/crypto/md5/browser';
import type { Md5Input } from '@/libs/crypto/md5/core';
import { Md5hash } from '@/libs/crypto/md5/service';

export const initMd5HashLayer = async (): Promise<Layer.Layer<Md5hash>> => {
  if (import.meta.env.SSR) {
    const { Md5HashServerLive } = await import('@/libs/crypto/md5/server');
    return Md5HashServerLive;
  }
  return Md5HashBrowserLive;
};

const layer = await initMd5HashLayer();

// Wrap effect, because md5 utils are pure functions we could invoke Effect.run* safely
export const md5 = (input: Md5Input) =>
  Effect.runSync(
    Md5hash.pipe(
      Effect.flatMap((s) => s.md5(input)),
      Effect.provide(layer),
    ),
  );

export const md5Fingerprint = (value: string) =>
  Effect.runSync(
    Md5hash.pipe(
      Effect.flatMap((s) => s.md5Fingerprint(value)),
      Effect.provide(layer),
    ),
  );

export const partialMd5 = (file: File) =>
  Effect.runPromise(
    Md5hash.pipe(
      Effect.flatMap((s) => s.partialMd5(file)),
      Effect.provide(layer),
    ),
  );

export function isMd5(value: string): boolean {
  return /^[0-9a-f]{32}$/.test(value);
}
