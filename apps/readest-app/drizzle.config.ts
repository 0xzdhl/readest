import { config } from 'dotenv';
import { defineConfig } from 'drizzle-kit';

config({ path: ['.env', '.env.prod'], override: true });

// Migrations create roles, grant table privileges and FORCE row-level security,
// so they need a SUPERUSER connection. The runtime app, by contrast, MUST
// connect as the non-superuser `readest_app` role (see migration 0004) so RLS
// actually enforces per-user scoping. Use a dedicated `DATABASE_MIGRATION_URL`
// for drizzle-kit when present, falling back to `DATABASE_URL` for backward
// compatibility (single-URL/superuser setups, CI).
const migrationUrl = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;

if (!migrationUrl) {
  throw new Error('DATABASE_MIGRATION_URL (or DATABASE_URL) is unset.');
}

export default defineConfig({
  schema: './src/db/schema/index.ts',
  out: './src/db/migrations',
  dialect: 'postgresql',
  dbCredentials: { url: migrationUrl },
  strict: true,
  verbose: true,
});
