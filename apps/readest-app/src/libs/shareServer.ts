import { customAlphabet } from 'nanoid';
import { and, eq, isNull } from 'drizzle-orm';
import { bookShares, files } from '@/db/schema';

// 22-char URL-safe alphabet (alphanumeric only — no `-` or `_`). Avoids
// punctuation that some chat clients linkify oddly.
const SHARE_TOKEN_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const SHARE_TOKEN_LENGTH = 22;
const generator = customAlphabet(SHARE_TOKEN_ALPHABET, SHARE_TOKEN_LENGTH);

const SHARE_TOKEN_REGEX = new RegExp(`^[${SHARE_TOKEN_ALPHABET}]{${SHARE_TOKEN_LENGTH}}$`);

export const isValidShareToken = (token: unknown): token is string =>
  typeof token === 'string' && SHARE_TOKEN_REGEX.test(token);

// Generate a fresh share token. The raw value is shown to the user once at
// create-time; only the hash is persisted to the database. A leaked DB read
// therefore cannot recover live bearer credentials.
export const generateShareToken = async (): Promise<{ raw: string; hash: string }> => {
  const raw = generator();
  const hash = await hashShareToken(raw);
  return { raw, hash };
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
 * Tx parameter type imported lazily via a type-only import so the runtime
 * `@/db/client` module isn't pulled into pure-function tests. The
 * `@/db/client` module reads `process.env.DATABASE_URL` at import time and
 * throws when unset; a `import type` is erased at compile time and doesn't
 * trigger that side effect.
 */
import type { db as _dbForType } from '@/db/client';
type TxLike = Parameters<Parameters<typeof _dbForType.transaction>[0]>[0];

/**
 * Single source of truth for the "is this share alive and usable?" check.
 * Used by the public metadata, download, cover, og.png, and import routes
 * so the validation logic stays in one place.
 *
 * Phase 5 refactor: this function now takes a drizzle tx (typically the
 * bypass-RLS tx from `runPublic`) so the caller controls the transaction
 * scope. When no tx is supplied, the helper opens its own withBypassRls
 * tx — used by `og[.]png/render.tsx` which builds the response outside the
 * shared route helper, and by any incidental caller that just wants the
 * resolved share without a wider transaction.
 *
 * The two queries (book_shares row + the corresponding files rows) need
 * `withBypassRls` because there's no `app.user_id` for an anonymous
 * caller. The token's secrecy IS the security boundary; the
 * `WHERE token_hash = $1` filter is the lookup gate.
 */
export const resolveActiveShare = async (
  rawToken: string,
  tx?: TxLike,
): Promise<{ ok: true; share: ResolvedShare } | { ok: false; reason: ShareLookupRejection }> => {
  if (!isValidShareToken(rawToken)) {
    return { ok: false, reason: { kind: 'invalid_token' } };
  }
  if (!tx) {
    // Lazy import to keep this module free of any top-level `@/db/client`
    // side effects (see comment on `TxLike`). The dynamic import is only
    // hit at runtime when a caller doesn't pass a tx.
    const { withBypassRls } = await import('@/db/rls');
    return withBypassRls((newTx) => resolveActiveShare(rawToken, newTx));
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
