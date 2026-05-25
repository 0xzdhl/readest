import { randomBytes, randomUUID } from 'node:crypto';
import { createFileRoute } from '@tanstack/react-router';
import { desc, eq, sql } from 'drizzle-orm';
import { replicaKeys } from '@/db/schema';
import { rlsMiddleware } from '@/middlewares/rls';

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
 * Inlines the three legacy plpgsql RPCs (`replica_keys_create`,
 * `replica_keys_list`, `replica_keys_forget`) as drizzle/TypeScript.
 * Auth + RLS via `rlsMiddleware`; `app.user_id` is set on the tx so
 * scoping is automatic. The DELETE branch flips every encrypted-field
 * envelope off the user's replica rows in the same tx before deleting the
 * keys themselves.
 */
export const Route = createFileRoute('/api/sync/replica-keys')({
  server: {
    middleware: [rlsMiddleware],
    handlers: {
      GET: async ({ context }) => {
        const { tx } = context;
        try {
          const rows = await tx
            .select({
              saltId: replicaKeys.saltId,
              alg: replicaKeys.alg,
              // Base64-encode the bytea so the salt round-trips as a string
              // over JSON. Matches the legacy RPC's
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
      },

      POST: async ({ request, context }) => {
        const { user, tx } = context;
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
      },

      DELETE: async ({ context }) => {
        const { user, tx } = context;
        try {
          // Reproduce the legacy `replica_keys_forget` plpgsql function:
          //   1. For every replicas row owned by the caller that contains
          //      at least one cipher envelope (`v.alg` set on the value
          //      object), strip those entries from `fields_jsonb`.
          //   2. DELETE every replica_keys row for the caller.
          //
          // RLS gates both operations to user-owned rows; `app.user_id` is
          // already set on the tx by rlsMiddleware.
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
      },
    },
  },
});
