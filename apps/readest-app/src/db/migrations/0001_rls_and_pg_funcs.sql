-- Migration 0001: RLS policies, app role, and PG helper functions
-- This is a hand-written companion to the drizzle-kit generated 0000_fair_ezekiel.sql.
-- It:
--   1. Creates the readest_app role with login
--   2. Grants schema + table permissions to readest_app
--   3. Enables RLS on all business tables with self-access policies
--   4. Ports crdt_merge_replica + helper functions from the old migrations
--      (auth.uid() → current_setting('app.user_id', true))

-- ─────────────────────────────────────────────────────────────────────────
-- 1. Role
-- ─────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'readest_app') THEN
    CREATE ROLE readest_app LOGIN PASSWORD 'readest_app';
  END IF;
END
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. Schema-level grants
-- ─────────────────────────────────────────────────────────────────────────
GRANT USAGE ON SCHEMA public TO readest_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO readest_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO readest_app;

-- Default privileges so future migrations also grant to readest_app
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO readest_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO readest_app;

-- ─────────────────────────────────────────────────────────────────────────
-- 3. Enable RLS + per-table policies
--    Policy: user sees/writes their own rows, or bypass flag is set.
-- ─────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  tbl text;
  tables text[] := ARRAY[
    'books', 'book_configs', 'book_notes',
    'files',
    'book_shares',
    'replicas', 'replica_keys',
    'payments', 'subscriptions', 'customers',
    'apple_iap_subscriptions', 'google_iap_subscriptions'
  ];
BEGIN
  FOREACH tbl IN ARRAY tables LOOP
    -- Enable RLS
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
    -- Drop any existing policy with this name to make idempotent
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', tbl || '_self', tbl);
    -- Create the self-access policy
    EXECUTE format(
      $policy$
        CREATE POLICY %I ON public.%I
          FOR ALL
          USING (
            user_id = current_setting('app.user_id', true)
            OR current_setting('app.bypass_rls', true) = 'true'
          )
          WITH CHECK (
            user_id = current_setting('app.user_id', true)
            OR current_setting('app.bypass_rls', true) = 'true'
          )
      $policy$,
      tbl || '_self', tbl
    );
  END LOOP;
END
$$;

-- ─────────────────────────────────────────────────────────────────────────
-- 4. HLC helpers + crdt_merge_replica
--    Ported from docker/volumes/db/migrations/004_crdt_merge_replica_fn.sql
--    and 005_replica_manifest_cursor_updated_at.sql.
--    No auth.uid() calls in these function bodies.
-- ─────────────────────────────────────────────────────────────────────────

-- HLC max helper. NULLs lose. Lexicographic order = temporal order.
CREATE OR REPLACE FUNCTION public.hlc_max(a text, b text)
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN a IS NULL THEN b
    WHEN b IS NULL THEN a
    WHEN a >= b THEN a
    ELSE b
  END;
$$;

-- Field-level LWW merge for fields_jsonb. Per-key: keep envelope with larger t (HLC).
CREATE OR REPLACE FUNCTION public.crdt_merge_fields(local_fields jsonb, remote_fields jsonb)
RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
AS $$
DECLARE
  result jsonb := COALESCE(local_fields, '{}'::jsonb);
  k text;
  l_env jsonb;
  r_env jsonb;
  l_t text;
  r_t text;
  l_s text;
  r_s text;
BEGIN
  IF remote_fields IS NULL THEN
    RETURN result;
  END IF;
  FOR k IN SELECT jsonb_object_keys(remote_fields) LOOP
    r_env := remote_fields -> k;
    l_env := result -> k;
    IF l_env IS NULL THEN
      result := jsonb_set(result, ARRAY[k], r_env, true);
    ELSE
      l_t := l_env ->> 't';
      r_t := r_env ->> 't';
      IF r_t > l_t THEN
        result := jsonb_set(result, ARRAY[k], r_env, true);
      ELSIF r_t = l_t THEN
        l_s := COALESCE(l_env ->> 's', '');
        r_s := COALESCE(r_env ->> 's', '');
        IF r_s > l_s THEN
          result := jsonb_set(result, ARRAY[k], r_env, true);
        END IF;
      END IF;
    END IF;
  END LOOP;
  RETURN result;
END;
$$;

-- Content updated_at_ts = max over field HLCs and tombstone HLC.
CREATE OR REPLACE FUNCTION public.crdt_compute_updated_at(fields jsonb, deleted_at text)
RETURNS text
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
AS $$
DECLARE
  result text := COALESCE(deleted_at, '0000000000000-00000000-');
  k text;
  env jsonb;
  t text;
BEGIN
  IF fields IS NULL THEN
    RETURN result;
  END IF;
  FOR k IN SELECT jsonb_object_keys(fields) LOOP
    env := fields -> k;
    t := env ->> 't';
    IF t IS NOT NULL AND t > result THEN
      result := t;
    END IF;
  END LOOP;
  RETURN result;
END;
$$;

-- Full row CRDT merge (final version from migration 005).
-- No auth.uid() calls in the function body — the caller is responsible
-- for asserting current_setting('app.user_id') = p_user_id before calling.
CREATE OR REPLACE FUNCTION public.crdt_merge_replica(
  p_user_id text,
  p_kind text,
  p_replica_id text,
  p_fields_jsonb jsonb,
  p_manifest_jsonb jsonb,
  p_deleted_at_ts text,
  p_reincarnation text,
  p_updated_at_ts text,
  p_schema_version integer
) RETURNS public.replicas
LANGUAGE plpgsql
AS $$
DECLARE
  result public.replicas;
BEGIN
  INSERT INTO public.replicas AS r (
    user_id, kind, replica_id,
    fields_jsonb, manifest_jsonb, deleted_at_ts,
    reincarnation, updated_at_ts, schema_version
  ) VALUES (
    p_user_id, p_kind, p_replica_id,
    COALESCE(p_fields_jsonb, '{}'::jsonb),
    p_manifest_jsonb, p_deleted_at_ts,
    p_reincarnation, p_updated_at_ts, p_schema_version
  )
  ON CONFLICT (user_id, kind, replica_id) DO UPDATE SET
    fields_jsonb   = public.crdt_merge_fields(r.fields_jsonb, EXCLUDED.fields_jsonb),
    deleted_at_ts  = public.hlc_max(r.deleted_at_ts, EXCLUDED.deleted_at_ts),
    reincarnation  = CASE
                       WHEN r.reincarnation IS NULL AND EXCLUDED.reincarnation IS NULL
                         THEN NULL
                       WHEN r.reincarnation IS NOT NULL AND EXCLUDED.reincarnation IS NULL
                         THEN CASE
                                WHEN public.hlc_max(r.deleted_at_ts, EXCLUDED.deleted_at_ts) IS NULL
                                  OR r.updated_at_ts > public.hlc_max(r.deleted_at_ts, EXCLUDED.deleted_at_ts)
                                  THEN r.reincarnation
                                ELSE NULL
                              END
                       WHEN r.reincarnation IS NULL AND EXCLUDED.reincarnation IS NOT NULL
                         THEN CASE
                                WHEN public.hlc_max(r.deleted_at_ts, EXCLUDED.deleted_at_ts) IS NULL
                                  OR EXCLUDED.updated_at_ts > public.hlc_max(r.deleted_at_ts, EXCLUDED.deleted_at_ts)
                                  THEN EXCLUDED.reincarnation
                                ELSE NULL
                              END
                       WHEN EXCLUDED.updated_at_ts > r.updated_at_ts
                         THEN CASE
                                WHEN public.hlc_max(r.deleted_at_ts, EXCLUDED.deleted_at_ts) IS NULL
                                  OR EXCLUDED.updated_at_ts > public.hlc_max(r.deleted_at_ts, EXCLUDED.deleted_at_ts)
                                  THEN EXCLUDED.reincarnation
                                ELSE NULL
                              END
                       ELSE CASE
                              WHEN public.hlc_max(r.deleted_at_ts, EXCLUDED.deleted_at_ts) IS NULL
                                OR r.updated_at_ts > public.hlc_max(r.deleted_at_ts, EXCLUDED.deleted_at_ts)
                                THEN r.reincarnation
                              ELSE NULL
                            END
                     END,
    manifest_jsonb = CASE
                       WHEN EXCLUDED.manifest_jsonb IS NULL
                         THEN r.manifest_jsonb
                       WHEN r.manifest_jsonb IS NULL
                         THEN EXCLUDED.manifest_jsonb
                       WHEN EXCLUDED.updated_at_ts > r.updated_at_ts
                         THEN EXCLUDED.manifest_jsonb
                       ELSE r.manifest_jsonb
                     END,
    schema_version = GREATEST(r.schema_version, EXCLUDED.schema_version),
    updated_at_ts  = public.hlc_max(
                       public.hlc_max(r.updated_at_ts, EXCLUDED.updated_at_ts),
                       public.crdt_compute_updated_at(
                         public.crdt_merge_fields(r.fields_jsonb, EXCLUDED.fields_jsonb),
                         public.hlc_max(r.deleted_at_ts, EXCLUDED.deleted_at_ts)
                       )
                     ),
    modified_at    = now()
  RETURNING * INTO result;
  RETURN result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.hlc_max(text, text) TO readest_app;
GRANT EXECUTE ON FUNCTION public.crdt_merge_fields(jsonb, jsonb) TO readest_app;
GRANT EXECUTE ON FUNCTION public.crdt_compute_updated_at(jsonb, text) TO readest_app;
GRANT EXECUTE ON FUNCTION public.crdt_merge_replica(text, text, text, jsonb, jsonb, text, text, text, integer) TO readest_app;
