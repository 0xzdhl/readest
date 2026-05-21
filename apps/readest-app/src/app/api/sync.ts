import { createFileRoute } from '@tanstack/react-router';
import {
  and,
  eq,
  getTableColumns,
  getTableName,
  gt,
  inArray,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { books, bookConfigs, bookNotes } from '@/db/schema';
import { resolveSessionOr401 } from '@/libs/server/auth-fn';
import { withRls } from '@/db/rls';
import { db } from '@/db/client';
import type { SyncData, SyncType } from '@/libs/sync';
import type { DBBook, DBBookConfig, DBBookNote } from '@/types/records';
import {
  transformBookConfigToDB,
  transformBookNoteToDB,
  transformBookToDB,
} from '@/utils/transform';

/**
 * Phase 4 of supabase→better-auth migration. Citations:
 *   - §3.3 RLS Strategy: every business table has a `_self` policy keyed
 *     on `current_setting('app.user_id', true)`, so once the route is
 *     inside `withRls(userId, ...)` no explicit `WHERE user_id = ?` is
 *     needed — Postgres enforces it.
 *   - §3.4 `withRls` Helper: opens the per-request transaction and sets
 *     `app.user_id`. Re-entered here both from the file-route handler
 *     (HTTP path) and from the integration test (which talks straight to
 *     the helpers; the protectedFn server-function wrapper is exercised
 *     by Phase 3 unit tests in `libs/server/auth-fn.test.ts`).
 *   - §4.3 Protected Server Function Template: `protectedFn` from
 *     `@/libs/server/auth-fn` composes the same `resolveSessionOr401` +
 *     `withRls` we call directly below. We don't compose it via
 *     `createServerFn` because file-route HTTP handlers and serverFn RPCs
 *     are separate dispatch paths in TanStack Start; the auth/RLS
 *     contract is identical either way.
 */

// Drizzle row types — internal to this module. The wire format is the
// snake_case `DB*` shape from `@/types/records` (kept stable so existing
// clients in `apps/readest-app/src/hooks/useSync.ts` consume it via
// `transformBook*FromDB` unchanged).
type BooksRow = typeof books.$inferSelect;
type BookConfigsRow = typeof bookConfigs.$inferSelect;
type BookNotesRow = typeof bookNotes.$inferSelect;

// camelCase drizzle row → snake_case wire shape. Date columns become
// ISO strings (the client's transformBook*FromDB expects strings).
const toIsoOrNull = (d: Date | string | null | undefined): string | null =>
  d == null ? null : d instanceof Date ? d.toISOString() : d;
const toIsoOrUndefined = (d: Date | string | null | undefined): string | undefined =>
  d == null ? undefined : d instanceof Date ? d.toISOString() : d;

function booksRowToDB(r: BooksRow): DBBook {
  return {
    user_id: r.userId,
    book_hash: r.bookHash,
    meta_hash: r.metaHash ?? undefined,
    format: r.format ?? '',
    title: r.title ?? '',
    source_title: r.sourceTitle ?? undefined,
    author: r.author ?? '',
    group_id: r.groupId ?? undefined,
    group_name: r.groupName ?? undefined,
    tags: r.tags ?? undefined,
    progress: (r.progress as [number, number] | null) ?? undefined,
    reading_status: r.readingStatus ?? undefined,
    metadata: r.metadata == null ? null : JSON.stringify(r.metadata),
    created_at: toIsoOrUndefined(r.createdAt),
    updated_at: toIsoOrUndefined(r.updatedAt),
    deleted_at: toIsoOrNull(r.deletedAt),
    uploaded_at: toIsoOrNull(r.uploadedAt),
  };
}

function bookConfigsRowToDB(r: BookConfigsRow): DBBookConfig {
  return {
    user_id: r.userId,
    book_hash: r.bookHash,
    meta_hash: r.metaHash ?? undefined,
    location: r.location ?? undefined,
    xpointer: r.xpointer ?? undefined,
    // `progress` / `search_config` / `view_settings` columns are jsonb; the
    // client's transformer JSON.parses them, so re-stringify here.
    progress: r.progress == null ? undefined : JSON.stringify(r.progress),
    rsvp_position: r.rsvpPosition ?? undefined,
    search_config: r.searchConfig == null ? undefined : JSON.stringify(r.searchConfig),
    view_settings: r.viewSettings == null ? undefined : JSON.stringify(r.viewSettings),
    created_at: toIsoOrUndefined(r.createdAt),
    updated_at: toIsoOrUndefined(r.updatedAt),
    deleted_at: toIsoOrNull(r.deletedAt),
  };
}

function bookNotesRowToDB(r: BookNotesRow): DBBookNote {
  return {
    user_id: r.userId,
    book_hash: r.bookHash,
    meta_hash: r.metaHash ?? undefined,
    id: r.id,
    type: r.type ?? '',
    cfi: r.cfi ?? undefined,
    xpointer0: r.xpointer0 ?? undefined,
    xpointer1: r.xpointer1 ?? undefined,
    page: r.page ?? undefined,
    text: r.text ?? undefined,
    style: r.style ?? undefined,
    color: r.color ?? undefined,
    note: r.note ?? '',
    created_at: toIsoOrUndefined(r.createdAt),
    updated_at: toIsoOrUndefined(r.updatedAt),
    deleted_at: toIsoOrNull(r.deletedAt),
  };
}

// Context passed by `protectedFn`-equivalent wiring (the route handler
// below, or the integration test). `tx` is a drizzle transaction already
// bound to `app.user_id = user.id`, so all RLS-protected reads/writes are
// scoped to the caller automatically.
export interface SyncHandlerContext {
  user: { id: string };
  // `db.transaction(...)`'s callback parameter type — exposed via
  // `Parameters<...>` to avoid leaking drizzle-internal symbols.
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0];
}

const SYNC_TYPE_FOR_TABLE: Record<'books' | 'bookConfigs' | 'bookNotes', SyncType> = {
  books: 'books',
  bookConfigs: 'configs',
  bookNotes: 'notes',
};

// Cap the per-table response to bound memory + serialization cost. The old
// route paged in 1k chunks until a short page; this single-shot fetch with a
// hard cap preserves the external contract (single JSON payload, same keys,
// same ordering) and is large enough for any realistic per-user sync.
const FETCH_LIMIT = 10_000;

/**
 * Build the `set:` map for `.onConflictDoUpdate({ target, set })` so every
 * non-conflict column is overwritten with the value from the row being
 * inserted (`EXCLUDED.*`). Pattern verified against drizzle docs (see
 * https://orm.drizzle.team/docs/guides/upsert "Multi-row upsert").
 */
function buildExcludedSet<TTable extends PgTable>(
  table: TTable,
  exclude: ReadonlyArray<keyof TTable['$inferSelect']>,
): Record<string, SQL> {
  const cols = getTableColumns(table);
  const result: Record<string, SQL> = {};
  for (const [key, col] of Object.entries(cols)) {
    if ((exclude as readonly string[]).includes(key)) continue;
    // `col.name` is the SQL column name (snake_case in our schema).
    result[key] = sql.raw(`excluded.${col.name}`);
  }
  return result;
}

/**
 * Last-write-wins gate for `.onConflictDoUpdate({ target, set, setWhere })`.
 * Translates the legacy supabase route's per-record comparison:
 *
 *   const clientIsNewer =
 *     clientDeletedAt > serverDeletedAt || clientUpdatedAt > serverUpdatedAt;
 *
 * into a `WHERE` clause that runs after `DO UPDATE SET …` so the server
 * silently drops stale payloads instead of clobbering newer state.
 *
 * `COALESCE(..., 'epoch')` is the SQL analogue of `new Date(undefined).getTime()
 * === 0` in the legacy JS: a null timestamp compares as "infinitely old", so
 * a non-null `excluded.deleted_at` always beats a null `<table>.deleted_at`
 * (matching the legacy tombstone semantics).
 *
 * The `WHERE` clause references `<table>.<col>` (existing row) and
 * `EXCLUDED.<col>` (proposed row); we emit raw column names via
 * `sql.raw(table_name)` so the helper works across all three tables without
 * needing per-table specialisation.
 */
function lwwSetWhere<TTable extends PgTable>(table: TTable): SQL {
  const cols = getTableColumns(table) as Record<string, { name: string }>;
  const tableName = getTableName(table);
  const updatedAtCol = cols['updatedAt']?.name ?? 'updated_at';
  const deletedAtCol = cols['deletedAt']?.name ?? 'deleted_at';
  return sql.raw(
    `COALESCE(excluded.${updatedAtCol}, 'epoch'::timestamptz) > ` +
      `COALESCE("${tableName}".${updatedAtCol}, 'epoch'::timestamptz) ` +
      `OR COALESCE(excluded.${deletedAtCol}, 'epoch'::timestamptz) > ` +
      `COALESCE("${tableName}".${deletedAtCol}, 'epoch'::timestamptz)`,
  );
}

export async function handleGet(
  request: Request,
  ctx: SyncHandlerContext,
): Promise<Response> {
  const { tx } = ctx;
  const { searchParams } = new URL(request.url);
  const sinceParam = searchParams.get('since');
  const typeParam = searchParams.get('type') as SyncType | undefined;
  const bookParam = searchParams.get('book');
  const metaHashParam = searchParams.get('meta_hash');

  if (!sinceParam) {
    return Response.json({ error: '"since" query parameter is required' }, { status: 400 });
  }
  const since = new Date(Number(sinceParam));
  if (Number.isNaN(since.getTime())) {
    return Response.json({ error: 'Invalid "since" timestamp' }, { status: 400 });
  }

  try {
    // Per-table query builder. RLS adds the implicit `user_id = $current`
    // predicate; we only contribute the freshness filter and optional
    // book/meta filters (matching the original supabase query semantics).
    const buildWhere = <
      TTable extends typeof books | typeof bookConfigs | typeof bookNotes,
    >(table: TTable): SQL | undefined => {
      const freshness = or(gt(table.updatedAt, since), gt(table.deletedAt, since));
      // Original behaviour: when BOTH `book` and `meta_hash` are present the
      // route OR'd them ("either match" — used to fetch a book and any
      // duplicate by metadata in one shot); when only one was present, AND'd.
      if (bookParam && metaHashParam) {
        return and(
          or(eq(table.bookHash, bookParam), eq(table.metaHash, metaHashParam)),
          freshness,
        );
      }
      if (bookParam) {
        return and(eq(table.bookHash, bookParam), freshness);
      }
      if (metaHashParam) {
        return and(eq(table.metaHash, metaHashParam), freshness);
      }
      return freshness;
    };

    const results: {
      books: DBBook[];
      configs: DBBookConfig[];
      notes: DBBookNote[];
    } = { books: [], configs: [], notes: [] };

    // Drizzle's `tx.select().from(T)` infers `T` so tightly that wrapping it
    // in a generic helper trips one of the "cannot reference a data-modifying
    // subquery" guard types. Inlining per table keeps the inference happy and
    // each query is a 3-liner — no real DRY win in extracting it.
    if (!typeParam || typeParam === SYNC_TYPE_FOR_TABLE['books']) {
      const rows = await tx
        .select()
        .from(books)
        .where(buildWhere(books))
        .orderBy(sql`${books.updatedAt} DESC`)
        .limit(FETCH_LIMIT);
      results.books = rows.map(booksRowToDB);
    }
    if (!typeParam || typeParam === SYNC_TYPE_FOR_TABLE['bookConfigs']) {
      const rows = await tx
        .select()
        .from(bookConfigs)
        .where(buildWhere(bookConfigs))
        .orderBy(sql`${bookConfigs.updatedAt} DESC`)
        .limit(FETCH_LIMIT);
      results.configs = rows.map(bookConfigsRowToDB);
    }
    if (!typeParam || typeParam === SYNC_TYPE_FOR_TABLE['bookNotes']) {
      const rows = await tx
        .select()
        .from(bookNotes)
        .where(buildWhere(bookNotes))
        .orderBy(sql`${bookNotes.updatedAt} DESC`)
        .limit(FETCH_LIMIT);
      results.notes = rows.map(bookNotesRowToDB);
    }

    return Response.json(results, {
      status: 200,
      headers: {
        'Cache-Control': 'no-store',
        Pragma: 'no-cache',
      },
    });
  } catch (error: unknown) {
    console.error('GET /api/sync failed', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return Response.json({ error: errorMessage }, { status: 500 });
  }
}

export async function handlePost(
  request: Request,
  ctx: SyncHandlerContext,
): Promise<Response> {
  const { user, tx } = ctx;
  const body = (await request.json()) as SyncData;
  const { books: booksPayload = [], configs: configsPayload = [], notes: notesPayload = [] } =
    body;

  try {
    // Upsert helpers — one per table because the conflict target / column
    // shape differs. Drizzle's `.onConflictDoUpdate({ target, set })` maps to
    // PG's `ON CONFLICT (...) DO UPDATE SET ...` with `excluded.col` as the
    // proposed-row reference (see drizzle docs §"Multi-row upsert").
    let outBooks: BooksRow[] = [];
    if (booksPayload.length > 0) {
      const rows = booksPayload
        .filter((b): b is NonNullable<typeof b> => b != null)
        .map((b) => transformBookToDB(b, user.id))
        .map((dbRec) => ({
          userId: dbRec.user_id,
          bookHash: dbRec.book_hash,
          metaHash: dbRec.meta_hash ?? null,
          format: dbRec.format ?? null,
          title: dbRec.title ?? null,
          sourceTitle: dbRec.source_title ?? null,
          author: dbRec.author ?? null,
          tags: dbRec.tags ?? null,
          progress: dbRec.progress ?? null,
          readingStatus: dbRec.reading_status ?? null,
          groupId: dbRec.group_id ?? null,
          groupName: dbRec.group_name ?? null,
          metadata: dbRec.metadata ?? null,
          createdAt: dbRec.created_at ? new Date(dbRec.created_at) : new Date(),
          updatedAt: dbRec.updated_at ? new Date(dbRec.updated_at) : new Date(),
          deletedAt: dbRec.deleted_at ? new Date(dbRec.deleted_at) : null,
          uploadedAt: dbRec.uploaded_at ? new Date(dbRec.uploaded_at) : null,
        }));
      // `setWhere` gates the UPDATE so stale client payloads (older
      // updated_at / deleted_at than the existing server row) are silently
      // dropped, matching the legacy supabase route's per-record LWW.
      // `.returning()` would only yield rows actually written; the legacy
      // API returned authoritative state for every incoming key, so we
      // SELECT them back after the upsert.
      await tx
        .insert(books)
        .values(rows)
        .onConflictDoUpdate({
          target: [books.userId, books.bookHash],
          set: buildExcludedSet(books, ['userId', 'bookHash']),
          setWhere: lwwSetWhere(books),
        });
      outBooks = await tx
        .select()
        .from(books)
        .where(inArray(books.bookHash, rows.map((r) => r.bookHash)));
    }

    let outConfigs: BookConfigsRow[] = [];
    if (configsPayload.length > 0) {
      const rows = configsPayload
        .filter((c): c is NonNullable<typeof c> => c != null)
        .map((c) => transformBookConfigToDB(c, user.id))
        .map((dbRec) => ({
          userId: dbRec.user_id,
          bookHash: dbRec.book_hash,
          metaHash: dbRec.meta_hash ?? null,
          location: dbRec.location ?? null,
          xpointer: dbRec.xpointer ?? null,
          // `progress`, `rsvpPosition`, `searchConfig`, `viewSettings` come
          // back JSON-stringified from transformBookConfigToDB but the
          // jsonb columns want a parsed value. Re-parse so PG stores
          // structured JSON, not a JSON-encoded string.
          progress: dbRec.progress ? JSON.parse(dbRec.progress) : null,
          rsvpPosition: dbRec.rsvp_position ?? null,
          searchConfig: dbRec.search_config ? JSON.parse(dbRec.search_config) : null,
          viewSettings: dbRec.view_settings ? JSON.parse(dbRec.view_settings) : null,
          createdAt: dbRec.created_at ? new Date(dbRec.created_at) : new Date(),
          updatedAt: dbRec.updated_at ? new Date(dbRec.updated_at) : new Date(),
          deletedAt: dbRec.deleted_at ? new Date(dbRec.deleted_at) : null,
        }));
      await tx
        .insert(bookConfigs)
        .values(rows)
        .onConflictDoUpdate({
          target: [bookConfigs.userId, bookConfigs.bookHash],
          set: buildExcludedSet(bookConfigs, ['userId', 'bookHash']),
          setWhere: lwwSetWhere(bookConfigs),
        });
      outConfigs = await tx
        .select()
        .from(bookConfigs)
        .where(inArray(bookConfigs.bookHash, rows.map((r) => r.bookHash)));
    }

    let outNotes: BookNotesRow[] = [];
    if (notesPayload.length > 0) {
      const rows = notesPayload
        .filter((n): n is NonNullable<typeof n> => n != null)
        .map((n) => transformBookNoteToDB(n, user.id))
        .map((dbRec) => ({
          userId: dbRec.user_id,
          bookHash: dbRec.book_hash,
          metaHash: dbRec.meta_hash ?? null,
          id: dbRec.id,
          type: dbRec.type ?? null,
          cfi: dbRec.cfi ?? null,
          xpointer0: dbRec.xpointer0 ?? null,
          xpointer1: dbRec.xpointer1 ?? null,
          text: dbRec.text ?? null,
          style: dbRec.style ?? null,
          color: dbRec.color ?? null,
          note: dbRec.note ?? null,
          page: dbRec.page ?? null,
          createdAt: dbRec.created_at ? new Date(dbRec.created_at) : new Date(),
          updatedAt: dbRec.updated_at ? new Date(dbRec.updated_at) : new Date(),
          deletedAt: dbRec.deleted_at ? new Date(dbRec.deleted_at) : null,
        }));
      await tx
        .insert(bookNotes)
        .values(rows)
        .onConflictDoUpdate({
          target: [bookNotes.userId, bookNotes.bookHash, bookNotes.id],
          set: buildExcludedSet(bookNotes, ['userId', 'bookHash', 'id']),
          setWhere: lwwSetWhere(bookNotes),
        });
      // Notes have a 3-column PK, so filter by (bookHash, id) pairs to
      // pick up exactly the incoming keys.
      const noteKeys = rows.map((r) => and(
        eq(bookNotes.bookHash, r.bookHash),
        eq(bookNotes.id, r.id),
      ));
      const noteFilter = or(...noteKeys);
      outNotes = noteFilter
        ? await tx.select().from(bookNotes).where(noteFilter)
        : [];
    }

    return Response.json(
      {
        books: outBooks.map(booksRowToDB),
        configs: outConfigs.map(bookConfigsRowToDB),
        notes: outNotes.map(bookNotesRowToDB),
      },
      { status: 200 },
    );
  } catch (error: unknown) {
    console.error('POST /api/sync failed', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return Response.json({ error: errorMessage }, { status: 500 });
  }
}

// File-route HTTP handler. The protectedFn server-function (see
// `@/libs/server/auth-fn`) shares the same `resolveSessionOr401` +
// `withRls` machinery; file-routes can't compose a serverFn directly
// (different dispatch path), so we inline the two-step equivalent here
// and feed the resulting `{ user, tx }` context into the pure handlers
// above — which are the same surface the integration test exercises.
async function runProtected(
  request: Request,
  inner: (ctx: SyncHandlerContext) => Promise<Response>,
): Promise<Response> {
  try {
    const session = await resolveSessionOr401(request.headers);
    return withRls(session.user.id, (tx) =>
      inner({ user: { id: session.user.id }, tx }),
    );
  } catch (e) {
    if (e instanceof Response) {
      // `resolveSessionOr401` throws a bare `Response('Unauthorized', 401)`.
      // The legacy supabase route returned `{ error: 'Not authenticated' }`
      // as JSON, and `apps/readest-app/src/hooks/useSync.ts:148` matches on
      // that substring to trigger silent re-login. Re-shape unauthenticated
      // responses so that contract holds; pass other Response throws
      // through unchanged.
      if (e.status === 401) {
        return Response.json({ error: 'Not authenticated' }, { status: 401 });
      }
      return e;
    }
    throw e;
  }
}

export const Route = createFileRoute('/api/sync')({
  server: {
    handlers: {
      GET: ({ request }) => runProtected(request, (ctx) => handleGet(request, ctx)),
      POST: ({ request }) => runProtected(request, (ctx) => handlePost(request, ctx)),
    },
  },
});
