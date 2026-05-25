import { createFileRoute } from '@tanstack/react-router';
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { replicas } from '@/db/schema';
import { validatePullBatch, validatePullParams, validatePushBatch } from '@/libs/replicaSyncServer';
import { rlsMiddleware } from '@/middlewares/rls';
import type { Hlc, ReplicaRow } from '@/types/replica';

const errorResponse = (status: number, code: string, message: string, offendingIndex?: number) =>
  Response.json(
    {
      error: message,
      code,
      ...(typeof offendingIndex === 'number' ? { offendingIndex } : {}),
    },
    { status },
  );

/**
 * Per-kind pull cap. Mirrors the legacy `limit(1000)` ceiling so a client
 * scanning a kind for the first time cannot blow up the response payload.
 */
const PULL_LIMIT = 1000;

type ReplicaDbRow = typeof replicas.$inferSelect;

/**
 * Map the drizzle row (camelCase) to the wire shape (`ReplicaRow`, snake_case).
 * `crdt_merge_replica` already returns the canonical merged row via
 * `RETURNS public.replicas`; we just rename keys.
 */
const rowToWire = (r: ReplicaDbRow): ReplicaRow => ({
  user_id: r.userId,
  kind: r.kind,
  replica_id: r.replicaId,
  fields_jsonb: r.fieldsJsonb as ReplicaRow['fields_jsonb'],
  manifest_jsonb: r.manifestJsonb as ReplicaRow['manifest_jsonb'],
  // The schema column is `text`; the wire is a branded `Hlc`. We
  // round-trip through the DB so the SQL itself is the source of truth —
  // cast back to the brand at the boundary.
  deleted_at_ts: (r.deletedAtTs ?? null) as Hlc | null,
  reincarnation: r.reincarnation,
  updated_at_ts: r.updatedAtTs as Hlc,
  schema_version: r.schemaVersion,
});

/**
 * GET / POST /api/sync/replicas — owner-only.
 *
 * GET = single-kind pull.
 * POST `{ cursors: [...] }` = batched pull (collapses N parallel GETs).
 * POST `{ rows: [...] }`    = CRDT push, routed through `crdt_merge_replica`.
 */
export const Route = createFileRoute('/api/sync/replicas')({
  server: {
    middleware: [rlsMiddleware],
    handlers: {
      GET: async ({ request, context }) => {
        const { tx } = context;
        const { searchParams } = new URL(request.url);
        const validation = validatePullParams(
          searchParams.get('kind'),
          searchParams.get('since'),
        );
        if (!validation.ok) {
          return errorResponse(validation.status, validation.code, validation.message);
        }
        const { kind, since } = validation.params;

        try {
          const where = since
            ? and(eq(replicas.kind, kind), gt(replicas.updatedAtTs, since))
            : eq(replicas.kind, kind);
          const rows = await tx
            .select()
            .from(replicas)
            .where(where)
            .orderBy(asc(replicas.updatedAtTs))
            .limit(PULL_LIMIT);
          return Response.json({ rows: rows.map(rowToWire) }, { status: 200 });
        } catch (error) {
          console.error('pull replicas failed', { kind, since, error });
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

        // Batched pull discriminator: `{ cursors: [...] }`.
        if (typeof body === 'object' && body !== null && 'cursors' in body) {
          const validation = validatePullBatch(body);
          if (!validation.ok) {
            return errorResponse(
              validation.status,
              validation.code,
              validation.message,
              validation.offendingIndex,
            );
          }
          const { cursors } = validation.params;
          if (cursors.length === 0) {
            return Response.json({ results: [] }, { status: 200 });
          }
          try {
            const tasks = cursors.map(async ({ kind, since }) => {
              const where = since
                ? and(eq(replicas.kind, kind), gt(replicas.updatedAtTs, since))
                : eq(replicas.kind, kind);
              const rows = await tx
                .select()
                .from(replicas)
                .where(where)
                .orderBy(asc(replicas.updatedAtTs))
                .limit(PULL_LIMIT);
              return { kind, rows: rows.map(rowToWire) };
            });
            const results = await Promise.all(tasks);
            return Response.json({ results }, { status: 200 });
          } catch (error) {
            console.error('batch pull replicas failed', { cursors, error });
            const message = error instanceof Error ? error.message : 'unknown error';
            return errorResponse(500, 'SERVER', message);
          }
        }

        // Otherwise: push branch.
        const validation = validatePushBatch(body, user.id, Date.now());
        if (!validation.ok) {
          return errorResponse(
            validation.status,
            validation.code,
            validation.message,
            validation.offendingIndex,
          );
        }

        const merged: ReplicaRow[] = [];
        for (const row of validation.rows) {
          try {
            const result = await tx.execute<ReplicaDbRow>(sql`
              SELECT (m).*
              FROM public.crdt_merge_replica(
                ${row.user_id},
                ${row.kind},
                ${row.replica_id},
                ${row.fields_jsonb}::jsonb,
                ${row.manifest_jsonb}::jsonb,
                ${row.deleted_at_ts},
                ${row.reincarnation},
                ${row.updated_at_ts},
                ${row.schema_version}
              ) AS m
            `);
            const rowsOut = Array.isArray(result)
              ? (result as ReplicaDbRow[])
              : ((result as { rows?: ReplicaDbRow[] }).rows ?? []);
            const first = rowsOut[0];
            if (first) {
              // The composite-row expansion comes back snake_case. drizzle
              // returns raw columns from .execute(sql`...`), so map both
              // shapes (camel or snake) to be safe across postgres-js
              // result layouts.
              const dbRow = first as ReplicaDbRow & {
                user_id?: string;
                replica_id?: string;
                fields_jsonb?: ReplicaRow['fields_jsonb'];
                manifest_jsonb?: ReplicaRow['manifest_jsonb'];
                deleted_at_ts?: string | null;
                updated_at_ts?: string;
                schema_version?: number;
              };
              const normalized: ReplicaDbRow = {
                userId: dbRow.userId ?? dbRow.user_id!,
                kind: dbRow.kind,
                replicaId: dbRow.replicaId ?? dbRow.replica_id!,
                fieldsJsonb: (dbRow.fieldsJsonb ??
                  dbRow.fields_jsonb)! as ReplicaDbRow['fieldsJsonb'],
                manifestJsonb: (dbRow.manifestJsonb ??
                  dbRow.manifest_jsonb ??
                  null) as ReplicaDbRow['manifestJsonb'],
                deletedAtTs: dbRow.deletedAtTs ?? dbRow.deleted_at_ts ?? null,
                reincarnation: dbRow.reincarnation ?? null,
                updatedAtTs: dbRow.updatedAtTs ?? dbRow.updated_at_ts!,
                schemaVersion: dbRow.schemaVersion ?? dbRow.schema_version!,
                createdAt: dbRow.createdAt ?? new Date(),
                modifiedAt: dbRow.modifiedAt ?? new Date(),
              };
              merged.push(rowToWire(normalized));
            }
          } catch (error) {
            console.error('crdt_merge_replica failed', { row, error });
            const message = error instanceof Error ? error.message : 'unknown error';
            return errorResponse(500, 'SERVER', message);
          }
        }

        return Response.json({ rows: merged }, { status: 200 });
      },
    },
  },
});
