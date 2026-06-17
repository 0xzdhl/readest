ALTER TABLE "files" ADD COLUMN "content_hash" text;
CREATE INDEX IF NOT EXISTS "idx_files_content_hash_live" ON "files" ("content_hash","deleted_at");

-- Cross-user live reference count for GC. SECURITY DEFINER so it ignores RLS
-- (it must see other users' rows) but returns ONLY a count — never row data.
CREATE OR REPLACE FUNCTION files_content_ref_count(p_content_hash text)
RETURNS bigint
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT count(*) FROM files
  WHERE content_hash = p_content_hash AND deleted_at IS NULL;
$$;
