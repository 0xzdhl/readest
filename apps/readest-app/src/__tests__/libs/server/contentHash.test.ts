import { describe, it, expect } from 'vitest';
import { sha256Hex, DEDUP_MAX_BYTES } from '@/libs/server/contentHash';
describe('sha256Hex', () => {
  it('hashes empty input to the SHA-256 of empty', async () => {
    expect(await sha256Hex(new ArrayBuffer(0))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
  it('hashes "abc"', async () => {
    expect(await sha256Hex(new TextEncoder().encode('abc').buffer)).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
  it('exposes the threshold', () => {
    expect(DEDUP_MAX_BYTES).toBe(26214400);
  });
});
