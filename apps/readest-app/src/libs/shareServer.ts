import { and, eq, isNull } from 'drizzle-orm';
import { customAlphabet } from 'nanoid';
import type { DbTx } from '@/db/rls';
import { bookShares, files } from '@/db/schema';
import { env } from '@/env';

// 22-char URL-safe alphabet (alphanumeric only — no `-` or `_`). Avoids
// punctuation that some chat clients linkify oddly.
const SHARE_TOKEN_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const SHARE_TOKEN_LENGTH = 22;
const generator = customAlphabet(SHARE_TOKEN_ALPHABET, SHARE_TOKEN_LENGTH);

const SHARE_TOKEN_REGEX = new RegExp(`^[${SHARE_TOKEN_ALPHABET}]{${SHARE_TOKEN_LENGTH}}$`);

export const isValidShareToken = (token: unknown): token is string =>
  typeof token === 'string' && SHARE_TOKEN_REGEX.test(token);

// Generate a fresh share token. The raw value is shown to the user once at
// create-time; the database stores only the SHA-256 hash (for O(1) lookup) and
// an AES-256-GCM-encrypted copy of the raw token (for owner management). Since
// neither the hash nor the ciphertext is reversible without the server's
// `BETTER_AUTH_SECRET`, a DB dump ALONE cannot recover live bearer credentials.
export const generateShareToken = async (): Promise<{ raw: string; hash: string }> => {
  const raw = generator();
  const hash = await hashShareToken(raw);
  return { raw, hash };
};

// ─── Token-at-rest encryption (Scheme B) ───────────────────────────────────
//
// The owner-management UI needs the raw token back (to copy/share the link),
// so a one-way hash alone is not enough. We therefore ALSO store the raw token
// encrypted under a key derived from the existing `BETTER_AUTH_SECRET` env (no
// new secret to manage). A DB dump without that env value yields only
// ciphertext; the live token cannot be recovered.
//
// Format: base64( iv(12 random bytes) || ciphertext+GCM-tag ).
// AAD: the row's `token_hash`, binding each ciphertext to exactly one row so a
// stolen ciphertext cannot be transplanted onto a different share row.

const HKDF_SALT = 'readest-share-token-hkdf-v1';
const HKDF_INFO = 'aes-256-gcm';
const AES_KEY_BYTES = 32;
const GCM_IV_BYTES = 12;

let cachedKeyPromise: Promise<CryptoKey> | null = null;

// Derive (once, then cache) the AES-256-GCM key via HKDF-SHA256 from
// BETTER_AUTH_SECRET. The salt/info are fixed app constants — versioned in the
// salt string so a future rotation can change the derivation deterministically.
const getShareEncryptionKey = (): Promise<CryptoKey> => {
  if (cachedKeyPromise) return cachedKeyPromise;
  cachedKeyPromise = (async () => {
    const ikm = new TextEncoder().encode(env.BETTER_AUTH_SECRET);
    const baseKey = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: new TextEncoder().encode(HKDF_SALT),
        info: new TextEncoder().encode(HKDF_INFO),
      },
      baseKey,
      { name: 'AES-GCM', length: AES_KEY_BYTES * 8 },
      false,
      ['encrypt', 'decrypt'],
    );
  })();
  return cachedKeyPromise;
};

const toBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
};

const fromBase64 = (b64: string): Uint8Array => {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
};

/**
 * Encrypt a raw share token for storage at rest. `aad` MUST be the row's
 * `token_hash` so the ciphertext is bound to its row. Returns
 * base64(iv || ciphertext+tag).
 */
export const encryptShareToken = async (raw: string, aad: string): Promise<string> => {
  const key = await getShareEncryptionKey();
  const iv = crypto.getRandomValues(new Uint8Array(GCM_IV_BYTES));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: iv as BufferSource,
        additionalData: new TextEncoder().encode(aad) as BufferSource,
      },
      key,
      new TextEncoder().encode(raw) as BufferSource,
    ),
  );
  const packed = new Uint8Array(iv.length + ciphertext.length);
  packed.set(iv, 0);
  packed.set(ciphertext, iv.length);
  return toBase64(packed);
};

// A stored value looks decryptable only if it is valid base64 that is at least
// long enough to hold the 12-byte IV plus a 16-byte GCM tag. Legacy plaintext
// tokens (22 url-safe chars, no `+`/`/`/`=`) will not satisfy the length floor
// in practice, but we still fall through to passthrough if decryption fails.
const MIN_PACKED_BYTES = GCM_IV_BYTES + 16;

/**
 * Decrypt a stored share token. `aad` MUST be the same `token_hash` used at
 * encrypt time.
 *
 * BACKWARD-COMPAT: if `stored` is not in the expected base64(iv||ct) format or
 * fails to decrypt/authenticate (e.g. a legacy pre-migration plaintext row, or
 * a value encrypted under a different AAD that we must not silently swap), the
 * value is returned AS-IS so existing shares keep working. Callers that need
 * strict authentication should not rely on this passthrough.
 */
export const decryptShareToken = async (stored: string, aad: string): Promise<string> => {
  let packed: Uint8Array;
  try {
    packed = fromBase64(stored);
  } catch {
    return stored; // not valid base64 → legacy plaintext passthrough
  }
  if (packed.length < MIN_PACKED_BYTES) {
    return stored; // too short to be our format → passthrough
  }
  try {
    const key = await getShareEncryptionKey();
    const iv = packed.subarray(0, GCM_IV_BYTES);
    const ciphertext = packed.subarray(GCM_IV_BYTES);
    const plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: iv as BufferSource,
        additionalData: new TextEncoder().encode(aad) as BufferSource,
      },
      key,
      ciphertext as BufferSource,
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    return stored; // wrong key/AAD/corrupt → passthrough (legacy compat)
  }
};

// SHA-256 of the raw token. Used at create (insert) and lookup (constant-time
// comparison via the unique index). Implemented with WebCrypto so it runs in
// both Node and edge runtimes.
export const hashShareToken = async (raw: string): Promise<string> => {
  const data = new TextEncoder().encode(raw);
  const buffer = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

// Reasons a share lookup may reject.
export type ShareLookupRejection =
  | { kind: 'invalid_token' }
  | { kind: 'not_found' }
  | { kind: 'revoked' }
  | { kind: 'expired' }
  | { kind: 'source_deleted' }
  | { kind: 'lookup_failed'; detail?: string };

export interface ResolvedShare {
  id: string;
  userId: string;
  bookHash: string;
  bookTitle: string;
  bookAuthor: string | null;
  bookFormat: string;
  bookSize: number;
  cfi: string | null;
  expiresAt: string;
  revokedAt: string | null;
  downloadCount: number;
  createdAt: string;
  bookFileKey: string;
  coverFileKey: string | null;
}

const isCoverKey = (fileKey: string): boolean => /\.(png|jpe?g|webp|gif)$/i.test(fileKey);

/** Coerce a drizzle timestamp (`Date | string | null`) to an ISO string or null. */
const toIso = (d: Date | string | null | undefined): string | null => {
  if (d == null) return null;
  if (d instanceof Date) return d.toISOString();
  return String(d);
};

/**
 * Single source of truth for the "is this share alive and usable?" check.
 * Used by the public metadata, download, cover, og.png, and import routes
 * so the validation logic stays in one place.
 *
 * Caller is responsible for providing a drizzle tx with RLS bypass set so
 * the cross-user reads (the sharer's `book_shares` and `files` rows) are
 * visible. In practice this means routes either compose `publicMiddleware`
 * (anonymous: a bypass-RLS tx already), or — when called from inside an
 * `rlsMiddleware` route that needs to read across user boundaries — first
 * flip the caller's tx with `setRlsBypass(tx)`. The token's secrecy IS the
 * security boundary; the `WHERE token_hash = $1` filter is the lookup gate.
 */
export const resolveActiveShare = async (
  rawToken: string,
  tx: DbTx,
): Promise<{ ok: true; share: ResolvedShare } | { ok: false; reason: ShareLookupRejection }> => {
  if (!isValidShareToken(rawToken)) {
    return { ok: false, reason: { kind: 'invalid_token' } };
  }

  const tokenHash = await hashShareToken(rawToken);

  let row: typeof bookShares.$inferSelect | undefined;
  try {
    const rows = await tx
      .select()
      .from(bookShares)
      .where(eq(bookShares.tokenHash, tokenHash))
      .limit(1);
    row = rows[0];
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown';
    return { ok: false, reason: { kind: 'lookup_failed', detail: message } };
  }
  if (!row) {
    return { ok: false, reason: { kind: 'not_found' } };
  }
  if (row.revokedAt) {
    return { ok: false, reason: { kind: 'revoked' } };
  }
  if (new Date(row.expiresAt).getTime() < Date.now()) {
    return { ok: false, reason: { kind: 'expired' } };
  }

  let fileRows: Array<{ fileKey: string }>;
  try {
    fileRows = await tx
      .select({ fileKey: files.fileKey })
      .from(files)
      .where(
        and(
          eq(files.userId, row.userId),
          eq(files.bookHash, row.bookHash),
          isNull(files.deletedAt),
        ),
      );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown';
    return { ok: false, reason: { kind: 'lookup_failed', detail: message } };
  }

  const bookFile = fileRows.find((f) => !isCoverKey(f.fileKey));
  if (!bookFile) {
    return { ok: false, reason: { kind: 'source_deleted' } };
  }
  const coverFile = fileRows.find((f) => isCoverKey(f.fileKey));

  return {
    ok: true,
    share: {
      id: row.id,
      userId: row.userId,
      bookHash: row.bookHash,
      bookTitle: row.bookTitle,
      bookAuthor: row.bookAuthor,
      bookFormat: row.bookFormat,
      bookSize: row.bookSize,
      cfi: row.cfi,
      expiresAt: toIso(row.expiresAt) ?? '',
      revokedAt: toIso(row.revokedAt),
      downloadCount: row.downloadCount,
      createdAt: toIso(row.createdAt) ?? '',
      bookFileKey: bookFile.fileKey,
      coverFileKey: coverFile?.fileKey ?? null,
    },
  };
};

// Maps the rejection kinds to the standard HTTP status + code combinations
// used by every share endpoint. Centralized so the JSON error shape is
// consistent across routes.
export const rejectionToHttp = (
  reason: ShareLookupRejection,
): { status: number; body: { error: string; code?: string } } => {
  switch (reason.kind) {
    case 'invalid_token':
      return { status: 400, body: { error: 'Invalid share token', code: 'invalid_token' } };
    case 'not_found':
      return { status: 404, body: { error: 'Share not found', code: 'not_found' } };
    case 'revoked':
      return { status: 410, body: { error: 'Share has been revoked', code: 'revoked' } };
    case 'expired':
      return { status: 410, body: { error: 'Share has expired', code: 'expired' } };
    case 'source_deleted':
      return {
        status: 410,
        body: { error: 'Shared book is no longer available', code: 'source_deleted' },
      };
    case 'lookup_failed':
      console.error('Share lookup failed:', reason.detail);
      return { status: 500, body: { error: 'Could not look up share' } };
  }
};
