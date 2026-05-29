-- Bootstrap the readest_app login role on first DB boot.
--
-- This init hook does not import schema or drizzle migration files. It only
-- ensures the application role exists before `pnpm db:migrate` connects.
-- Postgres only runs files under /docker-entrypoint-initdb.d on first
-- container start.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'readest_app') THEN
    CREATE ROLE readest_app LOGIN PASSWORD 'readest_app';
  END IF;
END $$;
