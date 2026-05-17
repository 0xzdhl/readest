import { createFileRoute } from '@tanstack/react-router';
import { createSupabaseClient } from '@/utils/supabase';
import { validateUserAndToken } from '@/utils/access';

const SUPPORTED_ALGS = new Set<string>(['pbkdf2-600k-sha256']);

interface ReplicaKeyRpcRow {
  salt_id: string;
  alg: string;
  salt_b64: string;
  created_at: string;
}

interface ReplicaKeyResponseRow {
  saltId: string;
  alg: string;
  salt: string;
  createdAt: string;
}

const errorResponse = (status: number, code: string, message: string) =>
  Response.json({ error: message, code }, { status });

const toResponseRow = (row: ReplicaKeyRpcRow): ReplicaKeyResponseRow => ({
  saltId: row.salt_id,
  alg: row.alg,
  salt: row.salt_b64,
  createdAt: row.created_at,
});

async function handleGet(request: Request): Promise<Response> {
  const { user, token } = await validateUserAndToken(
    request.headers.get('authorization') ?? undefined,
  );
  if (!user || !token) {
    return errorResponse(401, 'AUTH', 'Not authenticated');
  }
  const supabase = createSupabaseClient(token);

  const { data, error } = await supabase.rpc('replica_keys_list');
  if (error) {
    console.error('replica_keys_list failed', { userId: user.id, error });
    return errorResponse(500, 'SERVER', error.message);
  }
  const rows = (data ?? []) as ReplicaKeyRpcRow[];
  return Response.json({ rows: rows.map(toResponseRow) }, { status: 200 });
}

async function handlePost(request: Request): Promise<Response> {
  const { user, token } = await validateUserAndToken(
    request.headers.get('authorization') ?? undefined,
  );
  if (!user || !token) {
    return errorResponse(401, 'AUTH', 'Not authenticated');
  }

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
    return errorResponse(422, 'UNSUPPORTED_ALG', `Unsupported alg: ${String(alg)}`);
  }

  const supabase = createSupabaseClient(token);
  const { data, error } = await supabase
    .rpc('replica_keys_create', { p_alg: alg })
    .single<ReplicaKeyRpcRow>();
  if (error || !data) {
    console.error('replica_keys_create failed', { userId: user.id, error });
    return errorResponse(500, 'SERVER', error?.message ?? 'replica_keys_create returned no row');
  }
  return Response.json({ row: toResponseRow(data) }, { status: 201 });
}

async function handleDelete(request: Request): Promise<Response> {
  const { user, token } = await validateUserAndToken(
    request.headers.get('authorization') ?? undefined,
  );
  if (!user || !token) {
    return errorResponse(401, 'AUTH', 'Not authenticated');
  }
  const supabase = createSupabaseClient(token);
  const { error } = await supabase.rpc('replica_keys_forget');
  if (error) {
    console.error('replica_keys_forget failed', { userId: user.id, error });
    return errorResponse(500, 'SERVER', error.message);
  }
  return Response.json({ ok: true }, { status: 200 });
}

export const Route = createFileRoute('/api/sync/replica-keys')({
  server: {
    handlers: {
      GET: async ({ request }) => handleGet(request),
      POST: async ({ request }) => handlePost(request),
      DELETE: async ({ request }) => handleDelete(request),
    },
  },
});
