ALTER TABLE "files" ADD COLUMN "content_hash" text;
CREATE INDEX IF NOT EXISTS "idx_files_content_hash_live" ON "files" ("content_hash","deleted_at");

-- Cross-user live reference count for GC. SECURITY DEFINER so it ignores RLS
-- (it must see other users' rows) but returns ONLY a count — never row data.
--
-- OPERATIONAL INVARIANT: this migration MUST be run by a role that BYPASSES RLS
-- (superuser or the table owner), NOT by readest_app. The readest_app role is
-- subject to FORCE RLS (enforced from migration 0004). If this function were
-- owned by readest_app it would only count the caller's own rows even with
-- SECURITY DEFINER, because FORCE RLS applies to the function owner — and a GC
-- job would incorrectly consider a shared content object unreferenced and delete
-- it while other users still point to it. Run as postgres/superuser so the
-- SECURITY DEFINER execution context genuinely bypasses RLS.
CREATE OR REPLACE FUNCTION files_content_ref_count(p_content_hash text)
RETURNS bigint
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT count(*) FROM files
  WHERE content_hash = p_content_hash AND deleted_at IS NULL;
$$;

GRANT EXECUTE ON FUNCTION files_content_ref_count(text) TO readest_app;
