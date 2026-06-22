# Cross-user sync/isolation bugfix plan (2026-06-22)

Branch: `fix/cross-user-sync-isolation-2026-06-22` (off `main`).
Investigated via DB ground truth (psql, RLS-bypassed), MinIO object listing, and a 10-agent
adversarially-verified code investigation. Production is **Supabase Postgres**.

User decisions:
- Bug 4 → **last-write-wins** (newest timestamp wins, deliberate backward jumps sync). Monotonic-bump hardening.
- Bug 3 → **both**: code-level defense-in-depth (load-bearing, holds even if the connecting role bypasses RLS) **+** non-superuser role as backstop. Prod is Supabase.
- Cleanup → **yes** (vetted, soft-delete) **and remove the demo-books feature entirely**.

Test-first for every fix. Commit each step with `--no-verify` after self/subagent re-review.
Run `pnpm test` + `pnpm lint` at commit boundaries.

## Ground-truth facts
- App `.env` `DATABASE_URL=postgres://postgres:...` = **superuser** → RLS fully bypassed. `.env.example` ships the same. `readest_app` role exists, non-superuser, full DML grants on all 16 tables; `setRlsBypass` uses the `app.bypass_rls` GUC (works for any role). Switch is safe.
- Server pull (`api/sync.ts:220-235`) + push read-backs already carry explicit `eq(userId)` (defense-in-depth in main). Not the live leak vector.
- Object store: only `content/<sha>` objects exist; no per-user or staging objects. Both users' `files` rows carry the same `content_hash` → dedup healthy NOW (bug 2 latent).
- DB pollution: USER_B has USER_A's 西遊記(9cbb) verbatim (same progress/updated_at/uploaded_at); A has 2 demo phantom books (72dd,6afd: uploaded_at=NULL, no files); 9cbb book soft-deleted on A but its config not cascaded.

## Commits (sequential; review gate each)

### C1 — Remove demo-books feature + fix synced count (Bug 1)
- Delete `src/app/library/hooks/useDemoBooks.ts`; remove import + the `useEffect` at `index.tsx:570-585`; remove `demoBooks` var (`index.tsx:179`). Delete `src/data/demo/library.{en,zh}.json` (+ any now-unused demo assets) and the `demoBooksFetched` localStorage usage. Verify no other references.
- Extract `useSync.ts:148` count into exported pure helper `countSyncedRecords(type, records)` with a widened structural param (`{deleted_at?; uploaded_at?}`), gate books on `uploaded_at != null` (configs/notes keep deleted_at-only). Use it at `:148`.
- TEST-FIRST: `src/__tests__/hooks/useSync-synced-count.test.ts` — extract helper unchanged first (red on uploaded_at cases), then gate (green). Cases per finding.

### C2 — Flicker guarded merge (Bug 3b)
- Factor `processOldBook` merge (`useBooksSync.ts:121-136`) so a server `deletedAt` only propagates onto a local book on a **strictly-newer LWW win** (mirror `lwwSetWhere`: deletedAt wins only when `matching.deletedAt > old.deletedAt && matching.updatedAt >= old.updatedAt`); else keep `oldBook.deletedAt`.
- TEST-FIRST: pure-helper unit test — present local book + stale-tombstone synced row ⇒ stays visible.

### C3 — Client-side user scoping + account-switch guards (Bug 3a)
- Plumb `user_id` through `transformBookConfigFromDB` (DBBookConfig has it) into a wire field WITHOUT it being pushed back (pushConfig/serializeConfig must not send it; server stamps from ctx anyway). Add to `applyRemoteProgress` (`useProgressSync.ts:143`) and `prefetchProgress.pullRemoteConfig` a `user_id == null || user_id === user.id` guard.
- Add `loadedNamespace === getCurrentUserNamespace()` guard to `pullLibrary` (`useBooksSync.ts:44-64`) — ordered after libraryLoaded for the new user.
- Reset sync cursors (`settings.lastSyncedAtBooks/Configs/Notes` → 0 + force `lastSyncedAtInited` re-init) on account switch in `useUserScopedReset`, without clobbering other settings/device IDs.
- TESTS: client-merge user-scope unit (two rows different user_id ⇒ caller's wins); cursor-reset-on-switch test.

### C4 — Enforce RLS at DB (Bug 3a backstop, env/docs)
- `.env.example` DATABASE_URL → `readest_app` with comment: production (Supabase) must connect via a **non-superuser** role (not `postgres`/`service_role`) so FORCE RLS + `app.user_id` enforce; privileged ops use `setRlsBypass` GUC.
- TEST: `src/__tests__/app/api/sync-user-scope.test.ts` add a SUPERUSER-path case proving the explicit predicate (not RLS) scopes the pull.

### C5 — Finalize dedup hardening (Bug 2)
- `finalize.ts` sub-threshold branch: `onConflictDoUpdate({ target: files.fileKey, set: {contentHash, fileSize, bookHash}, setWhere: isNull(files.contentHash) })`. Do NOT touch deletedAt (no resurrection). Over-threshold branch stays `onConflictDoNothing`. Read-side rescue (download.ts) only if narrowly gated (replicaKind null + headObject-missing) — optional, lower priority.
- TEST-FIRST: extend finalize test harness mock to expose `onConflictDoUpdate`; assert persisted set carries `contentHash===sha` on a pre-existing NULL-contentHash collision; regression test over-threshold does NOT upsert contentHash.

### C6 — Reading-progress LWW (Bug 4)
- `useProgressSync.ts:166-182`: remove CFI `remoteIsAhead` veto from persist/push. Decide location+progress+**xpointer** together by `updatedAt`: remote newer ⇒ adopt all three; else drop all three from the merge. Keep `CFI.compare` ONLY for the `view.goTo` UX nudge (183-199).
- Monotonic timestamp: `bookDataStore.saveConfig` (`:95`) → `updatedAt = Math.max(Date.now(), (prev?.updatedAt ?? 0) + 1)`, **bounded** so a far-future pulled value can't pin the device ahead forever (cap to Date.now()+small, or only bump vs local not vs pulled).
- TEST-FIRST: invert `useProgressSync.test.tsx:152-190` to assert newer-but-earlier remote IS adopted; keep remote-ahead + xpointer tests green; add saveConfig monotonic-bump test.

### C7 — Data cleanup (vetted, soft-delete)
- Script `scripts/cleanup-cross-user-pollution.sql` (or node): identify (a) demo phantom books (uploaded_at NULL + no files rows + known demo hashes) and (b) leaked verbatim cross-user rows; soft-delete (set deleted_at) for the affected accounts. Cascade config tombstones. Show before/after counts. Run against local DB only; do NOT auto-run on prod.

## Verification (done-conditions)
`pnpm test`, `pnpm lint` at each boundary. No `any`. Re-review diff each commit.
