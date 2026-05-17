import { createFileRoute } from '@tanstack/react-router';
import { createSupabaseClient } from '@/utils/supabase';
import { validateUserAndToken } from '@/utils/access';
import { validatePullBatch, validatePullParams, validatePushBatch } from '@/libs/replicaSyncServer';
import type { ReplicaRow } from '@/types/replica';

const errorResponse = (status: number, code: string, message: string, offendingIndex?: number) =>
  Response.json(
    {
      error: message,
      code,
      ...(typeof offendingIndex === 'number' ? { offendingIndex } : {}),
    },
    { status },
  );

async function handlePost(request: Request): Promise<Response> {
  const { user, token } = await validateUserAndToken(
    request.headers.get('authorization') ?? undefined,
  );
  if (!user || !token) {
    return errorResponse(401, 'AUTH', 'Not authenticated');
  }
  const supabase = createSupabaseClient(token);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, 'VALIDATION', 'Invalid JSON body');
  }

  // Body discriminator: `{ cursors: [...] }` is a batched pull (replaces
  // N parallel `GET ?kind=K&since=…` calls with a single Worker
  // invocation); `{ rows: [...] }` is the existing push.
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
    // Per-kind queries run in parallel: each is the same SELECT the
    // single-kind GET issues, just dispatched together. Supabase calls
    // inside a Worker aren't billed as Cloudflare requests, so this
    // collapses N Worker invocations to 1 without changing DB load.
    try {
      const tasks = cursors.map(async ({ kind, since }) => {
        let query = supabase
          .from('replicas')
          .select('*')
          .eq('user_id', user.id)
          .eq('kind', kind)
          .order('updated_at_ts', { ascending: true })
          .limit(1000);
        if (since) query = query.gt('updated_at_ts', since);
        const { data, error } = await query;
        if (error) throw new Error(`pull replicas (kind=${kind}) failed: ${error.message}`);
        return { kind, rows: (data ?? []) as ReplicaRow[] };
      });
      const results = await Promise.all(tasks);
      return Response.json({ results }, { status: 200 });
    } catch (error) {
      console.error('batch pull replicas failed', { cursors, error });
      const message = error instanceof Error ? error.message : 'unknown error';
      return errorResponse(500, 'SERVER', message);
    }
  }

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
    const { data, error } = await supabase
      .rpc('crdt_merge_replica', {
        p_user_id: row.user_id,
        p_kind: row.kind,
        p_replica_id: row.replica_id,
        p_fields_jsonb: row.fields_jsonb,
        p_manifest_jsonb: row.manifest_jsonb,
        p_deleted_at_ts: row.deleted_at_ts,
        p_reincarnation: row.reincarnation,
        p_updated_at_ts: row.updated_at_ts,
        p_schema_version: row.schema_version,
      })
      .single<ReplicaRow>();

    if (error) {
      console.error('crdt_merge_replica failed', { row, error });
      return errorResponse(500, 'SERVER', error.message);
    }
    if (data) merged.push(data);
  }

  return Response.json({ rows: merged }, { status: 200 });
}

async function handleGet(request: Request): Promise<Response> {
  const { user, token } = await validateUserAndToken(
    request.headers.get('authorization') ?? undefined,
  );
  if (!user || !token) {
    return errorResponse(401, 'AUTH', 'Not authenticated');
  }
  const supabase = createSupabaseClient(token);

  const { searchParams } = new URL(request.url);
  const validation = validatePullParams(searchParams.get('kind'), searchParams.get('since'));
  if (!validation.ok) {
    return errorResponse(validation.status, validation.code, validation.message);
  }
  const { kind, since } = validation.params;

  let query = supabase
    .from('replicas')
    .select('*')
    .eq('user_id', user.id)
    .eq('kind', kind)
    .order('updated_at_ts', { ascending: true })
    .limit(1000);

  if (since) query = query.gt('updated_at_ts', since);

  const { data, error } = await query;
  if (error) {
    console.error('pull replicas failed', { kind, since, error });
    return errorResponse(500, 'SERVER', error.message);
  }

  return Response.json({ rows: data ?? [] }, { status: 200 });
}

export const Route = createFileRoute('/api/sync/replicas')({
  server: {
    handlers: {
      GET: async ({ request }) => handleGet(request),
      POST: async ({ request }) => handlePost(request),
    },
  },
});
