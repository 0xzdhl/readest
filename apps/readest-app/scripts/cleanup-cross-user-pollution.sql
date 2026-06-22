-- Cleanup: cross-user data pollution + demo/phantom book rows.
--
-- One-off remediation for data written before the 2026-06-22 sync isolation
-- fixes. SOFT-DELETE only (sets deleted_at) — reversible by clearing deleted_at.
-- Idempotent: re-running is a no-op (every UPDATE is guarded by deleted_at IS
-- NULL). Bumps updated_at = now() so the tombstone wins last-write-wins and the
-- pull freshness window propagates it to clients, which then remove the rows.
--
-- Targets (each has a clear, justifiable signature):
--   (a) Demo/phantom books: never uploaded (uploaded_at IS NULL) AND no live
--       files row. These are the seeded "demo books" the (now-removed) feature
--       pushed to the server, plus any metadata-only orphan.
--   (b) Cross-user leaked books: uploaded_at < the owner account's created_at —
--       impossible legitimately (you cannot have uploaded before your account
--       existed); the row is a verbatim copy leaked from another user.
--   (c) Orphaned book_configs: a live config whose book row is soft-deleted
--       (delete never cascaded to the config), incl. the configs of (a)/(b).
--
-- Run (admin / superuser, or any role — bypass GUC is honored by the policies):
--   psql "$DATABASE_MIGRATION_URL" -f scripts/cleanup-cross-user-pollution.sql
-- (locally: psql postgres://postgres:readest-dev@localhost:5432/postgres -f ...)

\set ON_ERROR_STOP on
BEGIN;

-- Cross-user cleanup must see/modify every user's rows.
SELECT set_config('app.bypass_rls', 'true', true);

-- ── BEFORE ────────────────────────────────────────────────────────────────
\echo '── BEFORE: rows that will be soft-deleted ──'
SELECT 'book (phantom/demo)' AS kind, user_id, book_hash, title
FROM books b
WHERE b.deleted_at IS NULL AND b.uploaded_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM files f
                  WHERE f.user_id = b.user_id AND f.book_hash = b.book_hash AND f.deleted_at IS NULL)
UNION ALL
SELECT 'book (cross-user leak)', b.user_id, b.book_hash, b.title
FROM books b JOIN "user" u ON u.id = b.user_id
WHERE b.deleted_at IS NULL AND b.uploaded_at IS NOT NULL AND b.uploaded_at < u.created_at
ORDER BY 1, 2;

-- ── (a) + (b) soft-delete the offending book rows ──────────────────────────
UPDATE books b
SET deleted_at = now(), updated_at = now()
WHERE b.deleted_at IS NULL
  AND b.uploaded_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM files f
                  WHERE f.user_id = b.user_id AND f.book_hash = b.book_hash AND f.deleted_at IS NULL);

UPDATE books b
SET deleted_at = now(), updated_at = now()
FROM "user" u
WHERE u.id = b.user_id
  AND b.deleted_at IS NULL
  AND b.uploaded_at IS NOT NULL
  AND b.uploaded_at < u.created_at;

-- ── (c) cascade: tombstone any live config whose book row is soft-deleted ───
UPDATE book_configs c
SET deleted_at = now(), updated_at = now()
WHERE c.deleted_at IS NULL
  AND EXISTS (SELECT 1 FROM books b
              WHERE b.user_id = c.user_id AND b.book_hash = c.book_hash AND b.deleted_at IS NOT NULL);

-- ── AFTER ───────────────────────────────────────────────────────────────────
\echo '── AFTER: remaining live (non-deleted) books per user ──'
SELECT user_id, count(*) AS live_books
FROM books WHERE deleted_at IS NULL
GROUP BY user_id ORDER BY user_id;

\echo '── AFTER: remaining live configs whose book is deleted (should be 0) ──'
SELECT count(*) AS orphaned_live_configs
FROM book_configs c
WHERE c.deleted_at IS NULL
  AND EXISTS (SELECT 1 FROM books b
              WHERE b.user_id = c.user_id AND b.book_hash = c.book_hash AND b.deleted_at IS NOT NULL);

COMMIT;
