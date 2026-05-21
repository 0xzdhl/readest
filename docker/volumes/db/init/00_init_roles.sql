-- Bootstrap the readest_app login role on first DB boot.
--
-- The drizzle migration `0001_rls_and_pg_funcs.sql` also creates this role
-- idempotently, but doing it here means the role exists *before* anything
-- else (drizzle migrations, app boot) tries to connect as it. Postgres only
-- runs files under /docker-entrypoint-initdb.d on first container start.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'readest_app') THEN
    CREATE ROLE readest_app LOGIN PASSWORD 'readest_app';
  END IF;
END $$;
