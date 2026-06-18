# Prefetch reading progress on library launch

**Date:** 2026-06-18
**Status:** Approved (design)
**Area:** `apps/readest-app` — library → reader handoff, cloud progress sync

## Problem

Opening a book shows page 1 first, then jumps to the synced reading position.

Today the open path uses only the **local** config:

- `initViewState` (`src/store/readerStore.ts`) loads the local config and writes
  `booksData[id].config`. It never consults the cloud.
- `FoliateViewer` opens the view via `view.init({ lastLocation })` where
  `lastLocation = URL cfi ?? config.location` (`FoliateViewer.tsx:597-606`).
- On a new device (book freshly downloaded, no local progress),
  `config.location` is empty → `view.goToFraction(0)` → **page 1**.
- `useProgressSync` pulls cloud progress on a separate async effect; when it
  resolves, `applyRemoteProgress` calls `view.goTo(remoteCFILocation)`
  (`useProgressSync.ts:191`) — the visible **jump**.

Nothing in the open path waits for cloud progress. That is the root cause.

## Goal

When a book is launched from the library, fetch its cloud progress **in
parallel** (overlapping the book download / route navigation) so the reader's
first paint is already at the synced position. No page-1 flash, no jump.

Non-goals: changing the sync protocol; changing `useProgressSync`'s live
reconciliation; covering every reader entry point (deep-link / open-with degrade
gracefully to today's behavior).

## Design

Three small, independent pieces.

### 1. Prefetch cache module — `src/services/sync/prefetchProgress.ts`

A module-level `Map<bookHash, Promise<BookConfig | null>>` plus two functions:

- `prefetchBookProgress(book: Book): void`
  - Fire-and-forget. No-op unless authenticated **and**
    `isSyncCategoryEnabled('progress')` (from `@/services/sync/syncCategories`).
  - Calls `syncClient.pullChanges(0, 'configs', book.hash, book.metaHash)`
    (`SyncClient` is self-authenticating via `buildAuthFetchOptions`; `since = 0`
    so we always get the book's latest config row, not an incremental delta).
  - Maps rows through `transformBookConfigFromDB` (`@/utils/transform`), picks
    the row whose `bookHash === book.hash || metaHash === book.metaHash` and is
    not `deletedAt`, and stores the resulting `Promise<BookConfig | null>` keyed
    by `book.hash`. Any error (offline / 401 / timeout) resolves to `null`.
  - Idempotent: if a promise for that hash is already in-flight, do nothing.

- `takePrefetchedProgress(bookHash: string, timeoutMs = 2000): Promise<BookConfig | null>`
  - Awaits the in-flight promise, racing a `timeoutMs` timer (returns `null` on
    timeout). **One-shot**: deletes the entry from the map afterward so a stale
    prefetch can never be reused on a later open.
  - Returns `null` if there is no entry for that hash.

### 2. Merge helper — `mergeRemoteOpenPosition(local, remote)` (same module, pure)

```
mergeRemoteOpenPosition(local: BookConfig, remote: BookConfig): BookConfig
```

- Adopts `remote.location` / `remote.progress` / `remote.xpointer` **only when
  the remote is strictly ahead**:
  `!local.location || CFI.compare(local.location, remote.location) < 0`.
  This is the same never-go-backwards invariant `applyRemoteProgress` enforces.
- Uses `remote.location` (a foliate-native CFI) directly — **no section-document
  parsing at open time** (keeps open fast). A pure-XPointer remote with no CFI
  (KOReader-only push) is left unchanged here and corrected later by
  `useProgressSync` (now resilient via `resolveRemoteProgressCFI`).
- Pure function, returns a new config object; does not mutate inputs.

### 3. Trigger + consume wiring

- **Trigger (library):** call `prefetchBookProgress(book)` immediately before the
  download/navigation in:
  - `src/app/library/components/BookshelfItem.tsx` — `handleBookClick`
  - `src/app/library/components/Bookshelf.tsx` — multi-select open
    It runs in parallel with `makeBookAvailable` (which awaits the download on a
    new device), so the network round-trip is hidden.

- **Consume (reader):** in `src/store/readerStore.ts` `initViewState`, right after
  `loadConfig` and before writing `booksData[id].config`:
  ```
  const remote = await takePrefetchedProgress(book.hash);
  if (remote) config = mergeRemoteOpenPosition(config, remote);
  ```
  Now `config.location` holds the synced position before `FoliateViewer`'s open
  effect reads it → `view.init({ lastLocation })` opens directly there.

## Data flow

```
library tap ─┬─> prefetchBookProgress(book)         (parallel network pull)
             └─> makeBookAvailable (download) ─> navigateToReader
                                                      │
                                              initViewState
                                                 loadConfig (local)
                                                 takePrefetchedProgress(hash) ──┐
                                                 mergeRemoteOpenPosition  <──────┘
                                                 booksData[id].config = merged
                                                      │
                                              FoliateViewer open effect
                                                 view.init({ lastLocation: config.location })
                                                      │
                                              first paint at synced position ✓
```

`useProgressSync` still mounts and pulls afterward, but now finds
`local.location === remote.location` → `CFI.compare(...) === 0` → no `goTo` → no
jump.

## Fallback / graceful degradation

Any of: no prefetch entry (deep-link / open-with), timeout, offline, 401, sync
category disabled, or no auth → `takePrefetchedProgress` returns `null` →
`initViewState` proceeds with the local config exactly as today. The book opens
locally and `useProgressSync` corrects later (its prior behavior). Zero
regression for offline / non-synced users.

## Defaults

- `timeoutMs = 2000` in `takePrefetchedProgress`.
- Prefetch wired into library-tap entry points only; other entry points degrade
  gracefully.

## Testing

- `mergeRemoteOpenPosition` (pure): remote ahead → adopt; remote behind → keep
  local; equal → keep local; local has no location → adopt remote; remote has no
  location → keep local.
- Prefetch cache: stash → take returns config; timeout → `null`; one-shot
  (second take → `null`); pull throws → `null`; disabled/no-auth → no-op (no map
  entry, take → `null`).
- Existing `useProgressSync` tests remain green (its behavior is unchanged).

## Out of scope (separate follow-up)

Deeper `xcfi` robustness: graceful **partial** XPointer path resolution so
KOReader-only sync (xpointer, no CFI) lands on the nearest resolvable ancestor
instead of failing. Tracked as its own TDD change.
