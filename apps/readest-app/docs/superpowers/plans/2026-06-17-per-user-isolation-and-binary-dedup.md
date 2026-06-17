# Per-User Data Isolation + Cross-User Binary Dedup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop cross-account data leakage (one user's books/progress/notes/highlights appearing in another user's account on the same device + on the server), then add content-hash dedup so identical book binaries upload once and are referenced by each owner.

**Architecture:** Phase 1 (P0, this plan's core) makes all per-user _metadata_ (the library index and per-book config that holds reading progress + notes/highlights) live under a per-user namespace on local disk, resets in-memory stores when the signed-in user id changes, guards the sync push so a device can never push a non-current-user's books, and hardens the server sync pull with an explicit `user_id` predicate so a mis-configured DB role can't leak rows. Book _binaries_ (epub/cover/nav) stay content-addressed and shared locally — they are the only thing safe to share. Phase 2 (separate, deferred) makes the _server_ store identical binaries once (content-addressed key with no user prefix) with a per-user reference + quota + refcount-GC model and a download access-control gate.

**Tech Stack:** TypeScript (strict, no `any`), Effect TS (ports/layers in `src/application` + `src/infra`), Zustand stores (`src/store`), TanStack Start server routes (`src/app/api`), Drizzle + Postgres + RLS, Vitest.

## Global Constraints

- Never use the `any` type — use `unknown`, proper types, or generics. (`.claude/rules/typescript.md`)
- Strict mode, target ES2022. Unused vars must be `_`-prefixed.
- Test-First: write a failing unit test BEFORE implementing each fix, run it to confirm it fails, then implement and confirm it passes. (`.claude/rules/test-first.md`)
- Done-conditions before claiming complete: `pnpm test`, `pnpm lint`; if `src-tauri/` changed also `pnpm fmt:check` + `pnpm clippy:check`. (`.claude/rules/verification.md`)
- Book binaries remain content-addressed and shared; ONLY binaries may ever be shared across users. Library/progress/notes/highlights are strictly per-user.
- Local metadata namespace key = the Better Auth user id when signed in, else the literal `'local'` for not-signed-in imports.
- Commit after each task with a conventional-commit message.

---

## Background: confirmed root cause (read before starting)

Two independent leak vectors produce the reported bug (A's book 西游记 + progress appearing under B, then 404 on open):

1. **Client push leak (primary, device-local).** Local stores + on-disk metadata are global (one `library.json`, one `settings.json`, `Books/<hash>/config.json`, one web IndexedDB `AppFileSystem`) and are never cleared/namespaced on account switch (`AuthContext.signOut` only calls `authClient.signOut()`). After A→B switch, A's books are still resident; `useBooksSync` auto-syncs on `[user, library]` change (`src/app/library/hooks/useBooksSync.ts:83-87`) and pushes them; the server force-stamps the current user id (`src/app/api/sync.ts:292` → `transformBookToDB(b, user.id)`), creating genuine B-owned records that point at files which only exist under A's storage prefix → download builds `${B}/Readest/Books/<hash>/...` (`src/libs/storage.ts:218`) → 404.
2. **Server pull leak (latent).** The sync pull WHERE has no `eq(userId)` predicate (`src/app/api/sync.ts:218-232`); it relies entirely on Postgres RLS, which is only `ENABLE`d, never `FORCE`d (`src/db/migrations/0001_rls_and_pg_funcs.sql`). A superuser/table-owner connection bypasses RLS and returns every user's rows. The local `.env` uses the `postgres` superuser.

Phase 1 closes both.

---

## File Structure (Phase 1)

**Create:**

- `src/services/userNamespace.ts` — synchronous current-namespace holder (`getCurrentUserNamespace`, `setCurrentUserNamespace`, subscribe). Read by pure path helpers; written by the auth-change hook.
- `src/utils/userPaths.ts` — namespaced storage-path helpers (`getLibraryStoragePath`, `getConfigStoragePath`, `getUserNamespaceDir`) built on `getCurrentUserNamespace()`. Canonical helpers in `utils/book.ts` stay unchanged (backup uses them).
- `src/hooks/useUserScopedReset.ts` — mounted once at app root; watches the auth user id; on a real id change, migrates legacy/anonymous data into the new namespace, resets in-memory stores, and lets the library re-init for the new user.
- `src/application/services/library/userDataMigration.ts` — Effect that moves legacy non-namespaced metadata (`library.json` + every `<hash>/config.json`) and the `'local'` namespace into a target user namespace, gated on the target being empty.
- Tests alongside each in `src/__tests__/...`.

**Modify:**

- `src/services/userNamespace.ts` consumers: `src/application/services/library/libraryData.ts` (use `getLibraryStoragePath()`), `src/application/services/book/bookData.ts` (config I/O → `getConfigStoragePath(book)`), `src/application/services/book/bookImport.ts` (config writes → `getConfigStoragePath(book)`).
- `src/store/libraryStore.ts` — add `resetForUserSwitch()` + track `loadedNamespace`.
- `src/store/bookDataStore.ts` — add `clearAll()`.
- `src/app/library/hooks/useBooksSync.ts` — push guard: skip push unless `loadedNamespace === getCurrentUserNamespace()`.
- `src/app/api/sync.ts` — add explicit `eq(table.userId, ctx.user.id)` to the pull WHERE (defense-in-depth).
- `src/db/migrations/` — new migration adding `FORCE ROW LEVEL SECURITY` (guarded; see Task 1 notes) + ops doc on the non-superuser role.
- App root (e.g. `src/components/Providers.tsx` or the library route) — mount `useUserScopedReset()`.

---

## Task 1: Server pull defense-in-depth (independent safety net, do first)

**Why first:** smallest change, closes the server-side cross-user pull regardless of which DB role prod uses, and is independently shippable.

**Files:**

- Modify: `src/app/api/sync.ts:218-232` (the `buildWhere` closure inside `handleGet`)
- Test: `src/__tests__/api/sync.test.ts` (extend) and/or new `src/__tests__/app/api/sync-user-scope.test.ts`

**Interfaces:**

- Produces: `handleGet` now always ANDs `eq(table.userId, ctx.user.id)` into every per-table WHERE, so a pull cannot return another user's rows even with RLS bypassed.

- [ ] **Step 1: Write the failing test.** Drive `handleGet` with a mocked `tx` whose `.select().from().where()` records the SQL/conditions, asserting the built WHERE for each table includes a `user_id = <ctx.user.id>` equality. (Mirror the existing harness in `src/__tests__/api/sync.test.ts`; assert against the drizzle condition tree or a fake tx that captures `.where(...)`.)
- [ ] **Step 2: Run it, expect FAIL** (`pnpm test src/__tests__/api/sync.test.ts` or the new file) — current WHERE has no user predicate.
- [ ] **Step 3: Implement.** In `buildWhere`, change the base predicate so every branch is `and(eq(table.userId, ctx.user.id), <existing predicate>)`. Concretely, thread `ctx.user.id` into `buildWhere` and wrap:

```ts
const buildWhere = <TTable extends typeof books | typeof bookConfigs | typeof bookNotes>(
  table: TTable,
): SQL | undefined => {
  const owner = eq(table.userId, ctx.user.id); // defense-in-depth; do NOT rely on RLS alone
  const freshness = or(gt(table.updatedAt, since), gt(table.deletedAt, since));
  if (bookParam && metaHashParam) {
    return and(
      owner,
      or(eq(table.bookHash, bookParam), eq(table.metaHash, metaHashParam)),
      freshness,
    );
  }
  if (bookParam) return and(owner, eq(table.bookHash, bookParam), freshness);
  if (metaHashParam) return and(owner, eq(table.metaHash, metaHashParam), freshness);
  return and(owner, freshness);
};
```

(`ctx` is in scope in `handleGet`; pass `ctx.user.id`.)

- [ ] **Step 4: Run the test, expect PASS.**
- [ ] **Step 5 (ops hardening, same task):** Add a Drizzle migration `00NN_force_rls.sql` issuing `ALTER TABLE ... FORCE ROW LEVEL SECURITY` for `books, book_configs, book_notes, files, replica_keys`. **Caution:** FORCE makes RLS apply to the table owner too, so verify every server DB path either sets `app.user_id` (rls middleware) or calls `setRlsBypass` (share/import/public) before merging — grep `context.db.transaction` / `createDbClient` callers. Add a one-line note to the repo's deploy doc: the runtime `DATABASE_URL` MUST use the non-superuser `readest_app` role (superuser/owner bypass RLS without FORCE). If FORCE can't be verified safe in this pass, ship Steps 1–4 alone (they already close the pull leak) and leave a TODO with the grep results.
- [ ] **Step 6: Verify + commit.** `pnpm test && pnpm lint`. If migration added, note `src-tauri` unaffected. Commit: `fix(sync): scope pull query to the authenticated user (defense-in-depth) + FORCE RLS`.

---

## Task 2: Current-user namespace holder

**Files:**

- Create: `src/services/userNamespace.ts`
- Test: `src/__tests__/services/userNamespace.test.ts`

**Interfaces:**

- Produces:
  - `getCurrentUserNamespace(): string` — returns the current namespace; defaults to `'local'`.
  - `setCurrentUserNamespace(userId: string | null): void` — sets to `userId` or `'local'` when null/empty.
  - `subscribeUserNamespace(cb: (ns: string) => void): () => void` — notify on change (returns unsubscribe).
  - `LOCAL_NAMESPACE = 'local'`.

- [ ] **Step 1: Write the failing test** `src/__tests__/services/userNamespace.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import {
  getCurrentUserNamespace,
  setCurrentUserNamespace,
  subscribeUserNamespace,
  LOCAL_NAMESPACE,
} from '@/services/userNamespace';

describe('userNamespace', () => {
  beforeEach(() => setCurrentUserNamespace(null));
  it('defaults to local', () => {
    expect(getCurrentUserNamespace()).toBe(LOCAL_NAMESPACE);
  });
  it('returns the user id when set', () => {
    setCurrentUserNamespace('user-A');
    expect(getCurrentUserNamespace()).toBe('user-A');
  });
  it('falls back to local on null/empty', () => {
    setCurrentUserNamespace('user-A');
    setCurrentUserNamespace('');
    expect(getCurrentUserNamespace()).toBe(LOCAL_NAMESPACE);
  });
  it('notifies subscribers only on change', () => {
    const seen: string[] = [];
    const off = subscribeUserNamespace((ns) => seen.push(ns));
    setCurrentUserNamespace('user-A');
    setCurrentUserNamespace('user-A');
    setCurrentUserNamespace('user-B');
    off();
    setCurrentUserNamespace('user-C');
    expect(seen).toEqual(['user-A', 'user-B']);
  });
});
```

- [ ] **Step 2: Run, expect FAIL** (module not found).
- [ ] **Step 3: Implement** `src/services/userNamespace.ts`:

```ts
export const LOCAL_NAMESPACE = 'local';

let currentNamespace = LOCAL_NAMESPACE;
const subscribers = new Set<(ns: string) => void>();

export const getCurrentUserNamespace = (): string => currentNamespace;

export const setCurrentUserNamespace = (userId: string | null): void => {
  const next = userId && userId.length > 0 ? userId : LOCAL_NAMESPACE;
  if (next === currentNamespace) return;
  currentNamespace = next;
  for (const cb of subscribers) cb(next);
};

export const subscribeUserNamespace = (cb: (ns: string) => void): (() => void) => {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
};
```

- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(storage): add per-user namespace holder`.

---

## Task 3: Namespaced storage-path helpers + relocate live metadata I/O

**Files:**

- Create: `src/utils/userPaths.ts`
- Test: `src/__tests__/utils/userPaths.test.ts`
- Modify: `src/application/services/library/libraryData.ts` (lines 18, 34), `src/application/services/book/bookData.ts` (lines 109-110, 138), `src/application/services/book/bookImport.ts` (lines 79, 336, 344, 356)

**Interfaces:**

- Consumes: `getCurrentUserNamespace` (Task 2).
- Produces (all relative to BaseDir `'Books'`):
  - `getUserNamespaceDir(): string` → `users/<ns>`
  - `getLibraryStoragePath(): string` → `users/<ns>/library.json`
  - `getConfigStoragePath(book: { hash: string }): string` → `users/<ns>/<hash>/config.json`
- Note: canonical `getLibraryFilename()` / `getConfigFilename()` in `utils/book.ts` are UNCHANGED and remain the backup/zip-canonical names. Binary helpers (`getLocalBookFilename`, `getCoverFilename`, `getBookNavFilename`) are UNCHANGED — binaries stay shared at `<hash>/...`.

- [ ] **Step 1: Write failing test** `src/__tests__/utils/userPaths.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { setCurrentUserNamespace } from '@/services/userNamespace';
import {
  getUserNamespaceDir,
  getLibraryStoragePath,
  getConfigStoragePath,
} from '@/utils/userPaths';

describe('userPaths', () => {
  beforeEach(() => setCurrentUserNamespace(null));
  it('namespaces under the current user', () => {
    setCurrentUserNamespace('user-A');
    expect(getUserNamespaceDir()).toBe('users/user-A');
    expect(getLibraryStoragePath()).toBe('users/user-A/library.json');
    expect(getConfigStoragePath({ hash: 'h1' })).toBe('users/user-A/h1/config.json');
  });
  it('uses local namespace when signed out', () => {
    expect(getLibraryStoragePath()).toBe('users/local/library.json');
  });
});
```

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** `src/utils/userPaths.ts`:

```ts
import { getCurrentUserNamespace } from '@/services/userNamespace';

export const getUserNamespaceDir = (): string => `users/${getCurrentUserNamespace()}`;
export const getLibraryStoragePath = (): string => `${getUserNamespaceDir()}/library.json`;
export const getConfigStoragePath = (book: { hash: string }): string =>
  `${getUserNamespaceDir()}/${book.hash}/config.json`;
```

- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Relocate live I/O.** In `libraryData.ts` replace `getLibraryFilename()` (lines 18, 34) with `getLibraryStoragePath()` (import from `@/utils/userPaths`; drop the now-unused `getLibraryFilename` import). In `bookData.ts` replace the two `getConfigFilename(book)` uses (lines 109-110, 138) with `getConfigStoragePath(book)`. In `bookImport.ts` replace the `getConfigFilename(book)` write sites (lines 336, 344, 356) and the existence probe at line 79 with `getConfigStoragePath(...)`. **Leave `src/services/backupService.ts` untouched** (it must keep canonical names).
- [ ] **Step 6: Add a focused regression test** asserting `loadLibraryBooks`/`saveLibraryBooks` round-trips under a namespace and that two namespaces don't see each other's library (use the in-memory web FS test layer used by existing `*.layer.test`; follow the pattern in `src/__tests__` for FileSystem-backed Effects). Run, expect PASS.
- [ ] **Step 7: Verify + commit.** `pnpm test && pnpm lint`. Commit: `feat(storage): namespace library.json + per-book config.json per user`.

---

## Task 4: Store reset primitives + push owner-guard

**Files:**

- Modify: `src/store/libraryStore.ts`, `src/store/bookDataStore.ts`, `src/app/library/hooks/useBooksSync.ts`
- Test: `src/__tests__/store/library-store.test.ts` (extend), `src/__tests__/app/library/books-sync-guard.test.ts` (new, optional if a lighter unit fits)

**Interfaces:**

- Produces:
  - `libraryStore.resetForUserSwitch(): void` — sets `library: [], libraryLoaded: false, hashIndex: new Map(), visibleLibrary: [], currentBookshelf: [], selectedBooks: new Set(), groups: {}`.
  - `libraryStore.loadedNamespace: string | null` — set inside `setLibrary` to `getCurrentUserNamespace()`; reset to `null` by `resetForUserSwitch`.
  - `bookDataStore.clearAll(): void` — sets `booksData: {}`.
- Consumes: `getCurrentUserNamespace` (Task 2). The push paths in `useBooksSync` (`getNewBooks`, `pushLibrary`, `handleAutoSync`) early-return unless `useLibraryStore.getState().loadedNamespace === getCurrentUserNamespace()`.

- [ ] **Step 1: Failing test** for `resetForUserSwitch` + `loadedNamespace` (extend `library-store.test.ts`): after `setLibrary([...])`, `loadedNamespace` equals the active ns and `libraryLoaded` is true; after `resetForUserSwitch()`, `library` is empty, `libraryLoaded` false, `loadedNamespace` null. Add a `bookDataStore.clearAll()` test.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Add `loadedNamespace: string | null` to `LibraryState` (init `null`); in `setLibrary` set `loadedNamespace: getCurrentUserNamespace()` alongside the existing fields; add `resetForUserSwitch`. Add `clearAll` to `bookDataStore`. Add the guard to `useBooksSync`:

```ts
// in getNewBooks(), pushLibrary(), and handleAutoSync(), before reading/pushing:
const st = useLibraryStore.getState();
if (!st.libraryLoaded || st.loadedNamespace !== getCurrentUserNamespace()) return /* {} or void */;
```

- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Verify + commit.** `pnpm test && pnpm lint`. Commit: `feat(library): add per-user reset + push owner-guard`.

---

## Task 5: Legacy + anonymous data migration

**Files:**

- Create: `src/application/services/library/userDataMigration.ts`
- Test: `src/__tests__/application/library/userDataMigration.test.ts`

**Interfaces:**

- Consumes: `FileSystem` port, `getCurrentUserNamespace`, `LOCAL_NAMESPACE`, canonical `getLibraryFilename`, namespaced `getUserNamespaceDir`/`getLibraryStoragePath`.
- Produces: `migrateIntoNamespace(targetNs: string): Effect<void, BookError, FileSystem>` — gated on `users/<targetNs>/library.json` being ABSENT, then, in priority order, moves (a) legacy canonical `Books/library.json` + every legacy `Books/<hash>/config.json` referenced by it, else (b) `users/local/*` → `users/<targetNs>/*` when `targetNs !== 'local'`. Moves are copy-then-delete of the JSON metadata only (binaries at `Books/<hash>/...` are shared and stay put).

- [ ] **Step 1: Failing test** (web FS test layer): seed canonical `library.json` + a `<hash>/config.json`; run `migrateIntoNamespace('user-A')`; assert `users/user-A/library.json` and `users/user-A/<hash>/config.json` now exist, the legacy canonical `library.json` is removed, and binaries are untouched. Second test: with `users/user-A/library.json` already present, migration is a no-op. Third: `local`→`user-B` adoption path.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** the Effect using the `FileSystem` port (`exists`, `readFile`, `writeFile`, `removeFile`/`remove`, `createDir`). Parse the source `library.json` to enumerate `<hash>` dirs whose `config.json` must move. Guard each step with `exists`. Map errors to `BookError`.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(storage): migrate legacy/anonymous metadata into per-user namespace`.

---

## Task 6: Wire reset + migration to auth user-id changes

**Files:**

- Create: `src/hooks/useUserScopedReset.ts`
- Modify: app root mount point — `src/components/Providers.tsx` (or the library route component) to call `useUserScopedReset()` once.
- Test: `src/__tests__/hooks/useUserScopedReset.test.tsx`

**Interfaces:**

- Consumes: `useAuth()` (`user.id`), `setCurrentUserNamespace`, `migrateIntoNamespace`, `libraryStore.resetForUserSwitch`, `bookDataStore.clearAll`, `useRunEffect`.
- Behavior: on mount and whenever `user?.id` transitions to a _different_ value (including →null = signed out), in order: (1) `setCurrentUserNamespace(user?.id ?? null)`, (2) `resetForUserSwitch()` + `bookDataStore.clearAll()`, (3) `await runEffect(migrateIntoNamespace(getCurrentUserNamespace()))`. Resetting `libraryLoaded` to false causes `useLibrary`'s init effect to reload the new namespace and `useBooksSync` to pull the new user's cloud (empty for fresh accounts → `since=0` full refresh).

- [ ] **Step 1: Failing test** (React Testing Library): mock `useAuth` to flip `user.id` A→B; assert `setCurrentUserNamespace` was called with B, the library store was reset (`libraryLoaded === false`), and `migrateIntoNamespace('B')` ran. Use a ref/spy on the store + a mocked `useRunEffect`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** the hook with a `useRef<string | null>` to track the last id and a guard so the same id doesn't re-trigger. Mount it in `Providers.tsx` (above the library tree, inside `AuthProvider`).
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(auth): reset + re-scope local data on account switch`.

---

## Task 7: End-to-end isolation regression test (the reported bug)

**Files:**

- Test: `src/__tests__/integration/account-switch-isolation.test.ts`

- [ ] **Step 1: Write the failing test** reproducing the report against the web FS + a fake sync client: as user A, import/persist a book (writes `users/A/library.json` + `users/A/<hash>/config.json`) and mark it uploaded under A's prefix. Switch namespace to B via the `useUserScopedReset` path (or call its constituents directly): assert (a) B's library load returns `[]` (no 西游记), (b) the push guard yields no push payload while A's data is resident during the transition, (c) `users/A/*` is intact and untouched. Assert the server `handleGet` WHERE (Task 1) would exclude A's rows for B.
- [ ] **Step 2: Run, expect FAIL** (pre-fix behavior leaks).
- [ ] **Step 3:** No new impl — this test validates Tasks 1–6 compose. If it fails, fix the responsible task.
- [ ] **Step 4: Run full suite** `pnpm test && pnpm lint`, expect PASS.
- [ ] **Step 5: Commit** `test(isolation): account-switch end-to-end regression`.

---

## Phase 2 (DEFERRED — separate plan): Cross-user binary dedup

Outline only; do NOT start until Phase 1 ships and a security review of the download access-control gate is approved. **Critical ordering constraint:** dedup MUST land on top of correct isolation + a download gate, otherwise a leaked/forged reference would let user B read user A's actual bytes.

- **Content key.** Add a shared, user-independent object key `content/<sha>/<sha>.<ext>` (sha = the existing content hash). Keep the existing per-user `files` rows but point them at the shared key. Migration plan for existing `<userId>/...` objects (lazy rewrite on next access or a background backfill).
- **Upload dedup.** `headObject(content/<sha>/...)`; on hit, skip the PUT and insert the caller's `files` reference row (quota counts the logical size for that user; bytes stored once). On miss, PUT then insert.
- **Download access-control gate.** `src/app/api/storage/download.ts` must verify the caller owns a live `files` reference (`user_id = caller AND book_hash/content matches AND deleted_at IS NULL`) BEFORE signing a URL for a shared content key. Never sign a shared-key URL from a client-supplied `fileKey` alone.
- **Refcount GC.** Deleting a user's reference must not delete shared bytes while another user references them. Add a reference count (or `COUNT(*) FROM files WHERE content_key = ? AND deleted_at IS NULL`) check; GC orphaned blobs via a sweep.
- **Privacy.** Avoid a hash existence-oracle: only confirm existence to a caller already proving possession (the upload flow implies they have the bytes); never expose "does content X exist" to arbitrary callers.
- **Quota.** Per-user logical accounting unchanged (sum of the user's reference sizes); physical storage deduped. Document that quota is logical, not physical.

---

## Self-Review

- **Spec coverage:** strict isolation of books (Tasks 3,4,6), progress + notes/highlights (config.json namespaced, Task 3), no cross-account push (Task 4 guard + Task 6 reset), no cross-account pull (Task 1), preserve each account's offline data (namespacing, not wipe — Tasks 3,5,6), binary dedup (Phase 2). ✓
- **Placeholder scan:** code provided for new modules; relocation tasks list exact files+lines; migration/integration tasks specify exact assertions and the FileSystem port methods to use. ✓
- **Type consistency:** `getCurrentUserNamespace`/`setCurrentUserNamespace`/`subscribeUserNamespace`/`LOCAL_NAMESPACE`, `getLibraryStoragePath`/`getConfigStoragePath`/`getUserNamespaceDir`, `resetForUserSwitch`/`loadedNamespace`/`clearAll`, `migrateIntoNamespace(targetNs)` — names used identically across tasks. ✓
