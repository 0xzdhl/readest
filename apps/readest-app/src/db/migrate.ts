import { pathToFileURL } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

export async function runMigrations(databaseUrl: string) {
  const sql = postgres(databaseUrl, { max: 1 });
  const db = drizzle(sql);
  await migrate(db, { migrationsFolder: './src/db/migrations' });
  await sql.end();
}

// Cross-platform "was this file invoked as the entrypoint?" check.
// `process.argv[1]` is a filesystem path; on Windows it's `E:\...\migrate.ts`,
// but `import.meta.url` is `file:///E:/.../migrate.ts`. Naively interpolating
// argv[1] into a `file://` URL produces a string that never matches, so
// `pnpm db:migrate` would silently no-op on Windows.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL not set');
  runMigrations(url).then(
    () => {
      console.log('migrations applied');
      process.exit(0);
    },
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
