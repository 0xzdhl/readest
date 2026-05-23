import { Effect, type Layer } from 'effect';
import { describe, expect, test } from 'vitest';
import { Md5HashBrowserLive } from '@/libs/crypto/md5/browser';
import type { Md5Input } from '@/libs/crypto/md5/core';
import { Md5HashServerLive } from '@/libs/crypto/md5/server';
import { Md5hash } from '@/libs/crypto/md5/service';

const createMd5Utils = (layer: Layer.Layer<Md5hash>) => {
  const md5 = (input: Md5Input, layer: Layer.Layer<Md5hash>) =>
    Effect.runSync(
      Md5hash.pipe(
        Effect.flatMap((s) => s.md5(input)),
        Effect.provide(layer),
      ),
    );

  const md5Fingerprint = (value: string, layer: Layer.Layer<Md5hash>) =>
    Effect.runSync(
      Md5hash.pipe(
        Effect.flatMap((s) => s.md5Fingerprint(value)),
        Effect.provide(layer),
      ),
    );

  const partialMd5 = (file: File, layer: Layer.Layer<Md5hash>) =>
    Effect.runPromise(
      Md5hash.pipe(
        Effect.flatMap((s) => s.partialMd5(file)),
        Effect.provide(layer),
      ),
    );

  return {
    md5: (input: Md5Input) => md5(input, layer),
    md5Fingerprint: (value: string) => md5Fingerprint(value, layer),
    partialMd5: (file: File) => partialMd5(file, layer),
  };
};

describe('md5 utilities (browser)', () => {
  const { md5: browserMd5 } = createMd5Utils(Md5HashBrowserLive);
  const { md5 } = createMd5Utils(Md5HashServerLive);

  test('keeps the browser implementation compatible with node crypto output', () => {
    expect(browserMd5('')).toBe(md5(''));
    expect(browserMd5('abc')).toBe(md5('abc'));
    expect(browserMd5('中文')).toBe(md5('中文'));
    expect(browserMd5(new Uint8Array([97, 98, 99]))).toBe(browserMd5(new Uint8Array([97, 98, 99])));
  });
});

describe('md5 utilities (Node.js)', () => {
  const { md5, md5Fingerprint, partialMd5 } = createMd5Utils(Md5HashServerLive);

  test('hashes strings and bytes with the standard MD5 digest', () => {
    expect(md5('')).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(md5('abc')).toBe('900150983cd24fb0d6963f7d28e17f72');
    expect(md5(new Uint8Array([97, 98, 99]))).toBe('900150983cd24fb0d6963f7d28e17f72');
    expect(md5('中文')).toBe('a7bac2239fcdcb3a067903d8077c4a07');
  });

  test('creates short fingerprints from MD5 hashes', () => {
    expect(md5Fingerprint('abc')).toBe('9001509');
  });

  test('hashes sampled file slices', async () => {
    const file = new File([new Uint8Array([97, 98, 99])], 'abc.txt');

    await expect(partialMd5(file)).resolves.toBe('900150983cd24fb0d6963f7d28e17f72');
  });
});
