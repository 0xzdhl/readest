-- Migration 0004: FORCE ROW LEVEL SECURITY on user-data tables
--
-- Background: ENABLE ROW LEVEL SECURITY makes RLS apply to non-owner roles,
-- but the table owner (or a superuser) bypasses it unless FORCE is also set.
-- A misconfigured DATABASE_URL pointing to the `postgres` superuser or the
-- table owner role therefore sees every user's rows.
--
-- FORCE ROW LEVEL SECURITY makes RLS apply to the table owner too, so the
-- row-level policies in migration 0001 are enforced for all roles.
--
-- IMPORTANT: before adding FORCE, every server DB transaction path must
-- either call set_config('app.user_id', ...) (rlsMiddleware) or
-- set_config('app.bypass_rls', 'true', true) (publicMiddleware /
-- shareRoute). Verified paths as of this migration:
--   - rlsMiddleware           → setRlsUserId(tx, userId)
--   - publicMiddleware        → setRlsBypass(tx)
--   - shareRoute createServerFn → setRlsBypass(tx)
-- Routes using only protectedMiddleware (ai/*, deepl, tts, metadata/search,
-- stripe/plans) open no database transactions, so FORCE has no effect on them.
--
-- NOTE: the runtime DATABASE_URL MUST use the non-superuser `readest_app`
-- role. Superuser connections still bypass even FORCE RLS at the Postgres
-- level. The predicate added in handleGet (eq(table.userId, ctx.user.id))
-- is a defense-in-depth layer that works regardless of DB role.

ALTER TABLE public.books          FORCE ROW LEVEL SECURITY;
ALTER TABLE public.book_configs   FORCE ROW LEVEL SECURITY;
ALTER TABLE public.book_notes     FORCE ROW LEVEL SECURITY;
ALTER TABLE public.files          FORCE ROW LEVEL SECURITY;
ALTER TABLE public.replica_keys   FORCE ROW LEVEL SECURITY;
