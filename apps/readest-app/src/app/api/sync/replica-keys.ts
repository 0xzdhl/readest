import { randomBytes, randomUUID } from 'node:crypto';
import { createFileRoute } from '@tanstack/react-router';
import { desc, eq, sql } from 'drizzle-orm';
import { replicaKeys } from '@/db/schema';
import { runProtected } from '@/libs/server/route-helpers';

const SUPPORTED_ALGS = new Set<string>(['pbkdf2-600k-sha256']);

interface ReplicaKeyResponseRow {
  saltId: string;
  alg: string;
  salt: string;
  createdAt: string;
}

const errorResponse = (status: number, code: string, message: string) =>
  Response.json({ error: message, code }, { status });

/**
 * Phase 5: inline the three legacy plpgsql RPCs
 * (`replica_keys_create`, `replica_keys_list`, `replica_keys_forget`) from
 * docker/volumes/db/migrations/{008,010}_*.sql as drizzle/TypeScript. The
 * RPCs were intentionally NOT ported into Phase 2's
 * `0001_rls_and_pg_funcs.sql` (see the "INTENTIONALLY UNPORTED LEGACY RPCs"
 * block in that file). Behaviour preserved per RPC body:
 *
 *   - `create`: gen_random_uuid()::text salt_id + gen_random_bytes(32) salt,
 *               INSERT and return { salt_id, alg, salt_b64, created_at }.
 *               Wire shape is the camelCase `{ saltId, alg, salt, createdAt }`
 *               consumed by replicaSyncClient.ts (`toResponseRow`).
 *   - `list`:   SELECT all keys for the current user, base64-encode salt,
 *               ORDER BY created_at DESC.
 *   - `forget`: strip every encrypted-field envelope (`v.alg` set on a
 *               cipher envelope) from each replicas.fields_jsonb row, then
 *               DELETE every replica_keys row for the user. RLS scopes
 *               both operations to the caller's rows automatically.
 *
 * Auth+RLS are enforced by `runProtected` (no `auth.uid()` to read here —
 * we replace it with `current_setting('app.user_id')`, which is exactly
 * what RLS uses).
 */
export const Route = createFileRoute('/api/sync/replica-keys')({
  server: {
    handlers: {
      GET: async ({ request }) =>
        runProtected(request, async ({ tx }) => {
          try {
            const rows = await tx
              .select({
                saltId: replicaKeys.saltId,
                alg: replicaKeys.alg,
                // Base64-encode the bytea so the salt round-trips as a
                // string over JSON. Matches the legacy RPC's
                // `encode(salt, 'base64') AS salt_b64`.
                saltB64: sql<string>`encode(${replicaKeys.salt}, 'base64')`,
                createdAt: replicaKeys.createdAt,
              })
              .from(replicaKeys)
              .orderBy(desc(replicaKeys.createdAt));
            const responseRows: ReplicaKeyResponseRow[] = rows.map((r) => ({
              saltId: r.saltId,
              alg: r.alg,
              salt: r.saltB64,
              createdAt:
                r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
            }));
            return Response.json({ rows: responseRows }, { status: 200 });
          } catch (error) {
            console.error('replica_keys list failed', { error });
            const message = error instanceof Error ? error.message : 'unknown error';
            return errorResponse(500, 'SERVER', message);
          }
        }),

      POST: async ({ request }) =>
        runProtected(request, async ({ user, tx }) => {
          let body: unknown;
          try {
            body = await request.json();
          } catch {
            return errorResponse(400, 'VALIDATION', 'Invalid JSON body');
          }
          const alg =
            typeof body === 'object' && body !== null && 'alg' in body
              ? (body as { alg: unknown }).alg
              : undefined;
          if (typeof alg !== 'string' || !SUPPORTED_ALGS.has(alg)) {
            return errorResponse(
              422,
              'UNSUPPORTED_ALG',
              `Unsupported alg: ${String(alg)}`,
            );
          }
          try {
            // gen_random_uuid()::text + gen_random_bytes(32) reproduced
            // in node — keeps the function pure SQL-free for portability.
            const saltId = randomUUID();
            const saltBuf = randomBytes(32);
            const [inserted] = await tx
              .insert(replicaKeys)
              .values({
                userId: user.id,
                saltId,
                alg,
                salt: saltBuf,
              })
              .returning({
                saltId: replicaKeys.saltId,
                alg: replicaKeys.alg,
                createdAt: replicaKeys.createdAt,
              });
            if (!inserted) {
              return errorResponse(500, 'SERVER', 'replica_keys_create returned no row');
            }
            const responseRow: ReplicaKeyResponseRow = {
              saltId: inserted.saltId,
              alg: inserted.alg,
              salt: saltBuf.toString('base64'),
              createdAt:
                inserted.createdAt instanceof Date
                  ? inserted.createdAt.toISOString()
                  : String(inserted.createdAt),
            };
            return Response.json({ row: responseRow }, { status: 201 });
          } catch (error) {
            console.error('replica_keys create failed', { userId: user.id, error });
            const message = error instanceof Error ? error.message : 'unknown error';
            return errorResponse(500, 'SERVER', message);
          }
        }),

      DELETE: async ({ request }) =>
        runProtected(request, async ({ user, tx }) => {
          try {
            // Reproduce the legacy `replica_keys_forget` plpgsql function:
            //   1. For every replicas row owned by the caller that contains
            //      at least one cipher envelope (`v.alg` set on the value
            //      object), strip those entries from `fields_jsonb`.
            //   2. DELETE every replica_keys row for the caller.
            //
            // RLS gates both operations to user-owned rows; `app.user_id`
            // is already set by runProtected → withRls.
            //
            // The UPDATE expression mirrors the SQL exactly: build a new
            // jsonb by aggregating only the (key, value) entries whose
            // value->'v' is NOT a cipher envelope. If the resulting object
            // is empty, COALESCE keeps it as '{}'.
            await tx.execute(sql`
              UPDATE public.replicas r
              SET fields_jsonb = (
                SELECT COALESCE(jsonb_object_agg(key, value), '{}'::jsonb)
                FROM jsonb_each(r.fields_jsonb)
                WHERE NOT (
                  jsonb_typeof(value -> 'v') = 'object'
                  AND value -> 'v' ? 'alg'
                )
              )
              WHERE r.user_id = current_setting('app.user_id', true)
                AND EXISTS (
                  SELECT 1 FROM jsonb_each(r.fields_jsonb) e
                  WHERE jsonb_typeof(e.value -> 'v') = 'object'
                    AND e.value -> 'v' ? 'alg'
                )
            `);
            await tx.delete(replicaKeys).where(eq(replicaKeys.userId, user.id));
            return Response.json({ ok: true }, { status: 200 });
          } catch (error) {
            console.error('replica_keys forget failed', { userId: user.id, error });
            const message = error instanceof Error ? error.message : 'unknown error';
            return errorResponse(500, 'SERVER', message);
          }
        }),
    },
  },
});
