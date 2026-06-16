import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Hermetic round-trip tests for the at-rest share-token encryption helpers in
 * `@/libs/shareServer`. No database required — these exercise the Web Crypto
 * (AES-256-GCM + HKDF-SHA256) path that runs identically in Node and workerd.
 *
 * The key is derived from `BETTER_AUTH_SECRET`, so we stub a baseline env and
 * re-import the module fresh for each test (the derived key is cached per
 * module instance).
 */

const stubBaselineEnv = () => {
  vi.stubEnv('DATABASE_URL', 'postgres://postgres:postgres@localhost:5432/postgres');
  vi.stubEnv('BETTER_AUTH_SECRET', 'test-secret-for-share-token-crypto');
  vi.stubEnv('BETTER_AUTH_URL', 'http://localhost:5173');
  vi.stubEnv('SMTP_FROM_EMAIL', 'from@example.com');
  vi.stubEnv('STORAGE_PUBLIC_BASE_URL', 'https://storage.example.com');
};

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  stubBaselineEnv();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

const importShareServer = async () => await import('@/libs/shareServer');

// A 22-char url-safe token, the shape produced by `generateShareToken`.
const RAW = 'ABCDEFGHIJKLMNOPQRSTuv';
const AAD = 'a'.repeat(64); // stand-in for a token_hash (64 hex chars)

describe('share-token at-rest encryption', () => {
  it('round-trips: decrypt(encrypt(raw)) === raw', async () => {
    const { encryptShareToken, decryptShareToken } = await importShareServer();
    const enc = await encryptShareToken(RAW, AAD);
    const dec = await decryptShareToken(enc, AAD);
    expect(dec).toBe(RAW);
  });

  it('ciphertext is not the plaintext and is non-deterministic (random IV)', async () => {
    const { encryptShareToken } = await importShareServer();
    const a = await encryptShareToken(RAW, AAD);
    const b = await encryptShareToken(RAW, AAD);
    expect(a).not.toBe(RAW);
    expect(a).not.toContain(RAW);
    // Distinct IVs => distinct ciphertexts for the same plaintext.
    expect(a).not.toBe(b);
  });

  it('wrong AAD fails to authenticate and falls through to passthrough', async () => {
    const { encryptShareToken, decryptShareToken } = await importShareServer();
    const enc = await encryptShareToken(RAW, AAD);
    // Decrypting with a different AAD must NOT yield the real token. Per the
    // backward-compat contract, an undecryptable value is returned as-is, so we
    // assert it is the stored ciphertext (i.e. not the recovered plaintext).
    const dec = await decryptShareToken(enc, 'b'.repeat(64));
    expect(dec).not.toBe(RAW);
    expect(dec).toBe(enc);
  });

  it('legacy plaintext passthrough: a raw 22-char token decrypts to itself', async () => {
    const { decryptShareToken } = await importShareServer();
    // A pre-migration row stored the plaintext token directly. It is not valid
    // base64-iv ciphertext, so decryptShareToken must return it unchanged.
    const dec = await decryptShareToken(RAW, AAD);
    expect(dec).toBe(RAW);
  });

  it('AAD binding: a ciphertext encrypted under one hash does not decrypt under another', async () => {
    const { encryptShareToken, decryptShareToken } = await importShareServer();
    const hash1 = '1'.repeat(64);
    const hash2 = '2'.repeat(64);
    const enc = await encryptShareToken(RAW, hash1);
    expect(await decryptShareToken(enc, hash1)).toBe(RAW);
    // Swapping the ciphertext onto a different row (different token_hash AAD)
    // must not recover the token.
    expect(await decryptShareToken(enc, hash2)).not.toBe(RAW);
  });
});
