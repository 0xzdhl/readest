import { Either } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedShare } from '@/libs/shareServer';

/**
 * Hermetic unit tests for /api/share/$token/import (no real DB).
 *
 * We mock `drizzle-orm`'s condition builders (`and/eq/isNull/isNotNull/sum`)
 * so they return inspectable descriptor objects, mock `@/db/schema` so the
 * `files` columns are plain named tokens, and drive the route handler with a
 * scripted mock `tx`. This lets us assert two business-logic bugs:
 *
 *   #6 — the "live recipient row" idempotency query (and the self-import
 *        query) must filter out tombstoned rows with `isNull(deletedAt)`,
 *        otherwise a soft-deleted row short-circuits the handler and the
 *        restore branch becomes dead code.
 *   #7 — the import quota gate must use REAL usage (sum of file_size for
 *        live rows in the same tx), not the never-written
 *        `user.storageUsageBytes`.
 */

// ── drizzle-orm: condition builders return inspectable descriptors ──────────
type Cond =
  | { op: 'eq'; col: unknown; val: unknown }
  | { op: 'isNull'; col: unknown }
  | { op: 'isNotNull'; col: unknown }
  | { op: 'and'; parts: Cond[] }
  | { op: 'sum'; col: unknown };

vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown): Cond => ({ op: 'eq', col, val }),
  isNull: (col: unknown): Cond => ({ op: 'isNull', col }),
  isNotNull: (col: unknown): Cond => ({ op: 'isNotNull', col }),
  and: (...parts: Cond[]): Cond => ({ op: 'and', parts }),
  sum: (col: unknown): Cond => ({ op: 'sum', col }),
}));

// ── @/db/schema: files columns become named string tokens ───────────────────
vi.mock('@/db/schema', () => ({
  files: {
    id: 'files.id',
    userId: 'files.userId',
    bookHash: 'files.bookHash',
    fileKey: 'files.fileKey',
    fileSize: 'files.fileSize',
    deletedAt: 'files.deletedAt',
    updatedAt: 'files.updatedAt',
  },
}));

// ── RLS bypass is a no-op against our mock tx ───────────────────────────────
vi.mock('@/db/rls', () => ({ setRlsBypass: vi.fn(async () => {}) }));

// ── share resolution is mocked; quota gate uses real getStoragePlanData ─────
const resolveActiveShareMock = vi.hoisted(() => vi.fn());
vi.mock('@/libs/shareServer', () => ({
  resolveActiveShare: resolveActiveShareMock,
  rejectionToHttp: (reason: { kind: string }) => ({ status: 410, body: { code: reason.kind } }),
}));

// ── storage copy always succeeds ────────────────────────────────────────────
vi.mock('@/storage', () => ({
  ObjectStorage: { copyObject: vi.fn() },
  runStorageProgram: vi.fn(async () => Either.right(undefined)),
}));

import { Route } from '@/app/api/share/$token/import/route';

type Handler = (args: {
  request: Request;
  params: Record<string, string>;
  context: Record<string, unknown>;
}) => Promise<Response>;

const getHandler = (): Handler => {
  const handler = (
    Route as unknown as {
      options: { server: { handlers: { POST: Handler } } };
    }
  ).options.server.handlers.POST;
  return handler;
};

const recipientId = 'recipient-user';
const sharerId = 'sharer-user';

const baseShare = (): ResolvedShare => ({
  id: 'share-1',
  userId: sharerId,
  bookHash: 'book-hash-1',
  bookTitle: 'Book',
  bookAuthor: null,
  bookFormat: 'EPUB',
  bookSize: 1000,
  cfi: null,
  expiresAt: new Date(Date.now() + 86400000).toISOString(),
  revokedAt: null,
  downloadCount: 0,
  createdAt: new Date().toISOString(),
  bookFileKey: `${sharerId}/Readest/Book/book-hash-1/book.epub`,
  coverFileKey: null,
});

/**
 * Scripted mock tx. `selectScript` is consumed in order: each `.select(...)`
 * chain pops one entry, records the captured WHERE condition, and resolves to
 * the entry's rows. `update(...)` records the set payload.
 */
interface SelectStep {
  rows: Record<string, unknown>[];
  cond?: Cond;
}

const makeTx = (selectScript: SelectStep[]) => {
  const captured: { selectConds: (Cond | undefined)[]; updates: unknown[] } = {
    selectConds: [],
    updates: [],
  };
  let stepIndex = 0;

  const tx = {
    execute: vi.fn(async () => undefined),
    select: () => ({
      from: () => ({
        where: (cond: Cond) => {
          const step = selectScript[stepIndex] ?? { rows: [] };
          stepIndex += 1;
          captured.selectConds.push(cond);
          return Promise.resolve(step.rows);
        },
      }),
    }),
    update: () => ({
      set: (payload: unknown) => ({
        where: (_cond: Cond) => {
          captured.updates.push(payload);
          return Promise.resolve(undefined);
        },
      }),
    }),
    insert: () => ({
      values: () => ({
        returning: () => Promise.resolve([{ id: 'new-file-id' }]),
      }),
    }),
  };
  return { tx, captured };
};

const userCtx = {
  id: recipientId,
  plan: 'free' as const,
  storageUsageBytes: 0,
  storagePurchasedBytes: 0,
};

const flatten = (cond: Cond | undefined): Cond[] => {
  if (!cond) return [];
  if (cond.op === 'and') return cond.parts.flatMap(flatten);
  return [cond];
};

const hasIsNullDeletedAt = (cond: Cond | undefined): boolean =>
  flatten(cond).some((c) => c.op === 'isNull' && c.col === 'files.deletedAt');

beforeEach(() => {
  resolveActiveShareMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('share/$token/import — tombstone-aware idempotency (#6)', () => {
  it('live-recipient-row idempotency query filters out tombstoned rows', async () => {
    resolveActiveShareMock.mockResolvedValue({ ok: true, share: baseShare() });

    // Script: [0] live query -> NO live rows (tombstoned rows must be excluded),
    //         [1] deleted query -> finds the tombstoned row (restore branch).
    const { tx, captured } = makeTx([
      { rows: [] },
      { rows: [{ id: 'dead-id', fileKey: `${recipientId}/Readest/Book/book-hash-1/book.epub` }] },
    ]);

    const res = await getHandler()({
      request: new Request('http://localhost/api/share/tok/import', { method: 'POST' }),
      params: { token: 'tok' },
      context: { user: userCtx, tx },
    });

    const body = (await res.json()) as { fileId?: string; alreadyOwned?: boolean };

    // The restore branch must be reachable: handler restored the tombstoned row.
    expect(captured.updates).toContainEqual(expect.objectContaining({ deletedAt: null }));
    expect(body.fileId).toBe('dead-id');

    // The live-recipient-row query (the first select after resolveActiveShare,
    // since this is a cross-user import: share.userId !== user.id) MUST carry
    // isNull(deletedAt) so tombstoned rows fall through to the restore branch.
    expect(hasIsNullDeletedAt(captured.selectConds[0])).toBe(true);
  });

  it('self-import query filters out tombstoned rows', async () => {
    const share = { ...baseShare(), userId: recipientId };
    resolveActiveShareMock.mockResolvedValue({ ok: true, share });

    // self-import select [0] -> empty (tombstone excluded),
    // live select [1] -> empty, deleted select [2] -> tombstone found.
    const { tx, captured } = makeTx([
      { rows: [] },
      { rows: [] },
      { rows: [{ id: 'dead-id', fileKey: `${recipientId}/Readest/Book/book-hash-1/book.epub` }] },
    ]);

    await getHandler()({
      request: new Request('http://localhost/api/share/tok/import', { method: 'POST' }),
      params: { token: 'tok' },
      context: { user: userCtx, tx },
    });

    // First select here is the self-import query.
    expect(hasIsNullDeletedAt(captured.selectConds[0])).toBe(true);
  });
});

describe('share/$token/import — quota gate uses real usage (#7)', () => {
  it('blocks import when summed live usage + bookSize exceeds quota', async () => {
    resolveActiveShareMock.mockResolvedValue({ ok: true, share: baseShare() });

    // Free plan quota is large; simulate near-full real usage so the gate trips.
    // [0] live query -> none, [1] deleted query -> none, [2] usage sum -> huge.
    const huge = 5 * 1024 * 1024 * 1024 * 1024; // 5 TiB
    const { tx, captured } = makeTx([
      { rows: [] },
      { rows: [] },
      { rows: [{ totalSize: String(huge) }] },
    ]);

    const res = await getHandler()({
      request: new Request('http://localhost/api/share/tok/import', { method: 'POST' }),
      params: { token: 'tok' },
      context: { user: { ...userCtx, storageUsageBytes: 0 }, tx },
    });

    expect(res.status).toBe(402);
    const body = (await res.json()) as { code?: string; usage?: number };
    expect(body.code).toBe('quota_exceeded');
    // Reported usage is the REAL summed usage, not user.storageUsageBytes (0).
    expect(body.usage).toBe(huge);

    // The usage query must sum file_size over live rows (isNull(deletedAt)).
    const usageCond = captured.selectConds[2];
    expect(hasIsNullDeletedAt(usageCond)).toBe(true);
  });
});
