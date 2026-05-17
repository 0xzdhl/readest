import { createFileRoute } from '@tanstack/react-router';
import { createSupabaseAdminClient } from '@/utils/supabase';
import { validateUserAndToken } from '@/utils/access';

interface FileRecord {
  file_key: string;
  file_size: number;
  book_hash: string | null;
  replica_kind: string | null;
  replica_id: string | null;
  created_at: string;
  updated_at: string | null;
}

interface ListFilesResponse {
  files: FileRecord[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export const Route = createFileRoute('/api/storage/list')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const { user, token } = await validateUserAndToken(
            request.headers.get('authorization') ?? undefined,
          );
          if (!user || !token) {
            return Response.json({ error: 'Not authenticated' }, { status: 403 });
          }

          const url = new URL(request.url);
          const page = parseInt(url.searchParams.get('page') || '') || 1;
          const pageSize = Math.min(parseInt(url.searchParams.get('pageSize') || '') || 50, 100);
          const sortBy = url.searchParams.get('sortBy') || 'created_at';
          const sortOrder = url.searchParams.get('sortOrder') === 'asc' ? 'asc' : 'desc';
          const bookHash = url.searchParams.get('bookHash') || undefined;
          const search = url.searchParams.get('search') || undefined;

          const supabase = createSupabaseAdminClient();

          let query = supabase
            .from('files')
            .select(
              'file_key, file_size, book_hash, replica_kind, replica_id, created_at, updated_at',
              {
                count: 'exact',
              },
            )
            .eq('user_id', user.id)
            .is('deleted_at', null);

          if (bookHash) {
            query = query.eq('book_hash', bookHash);
          }

          if (search) {
            query = query.ilike('file_key', `%${search}%`);
          }

          const validSortColumns = ['created_at', 'updated_at', 'file_size', 'file_key'];
          const sortColumn = validSortColumns.includes(sortBy) ? sortBy : 'created_at';
          query = query.order(sortColumn, { ascending: sortOrder === 'asc' });

          const from = (page - 1) * pageSize;
          const to = from + pageSize - 1;
          query = query.range(from, to);

          const { data: files, error: filesError, count } = await query;

          if (filesError) {
            console.error('Error querying files:', filesError);
            return Response.json({ error: 'Failed to retrieve files' }, { status: 500 });
          }

          const total = count || 0;
          const totalPages = Math.ceil(total / pageSize);

          // Pull every file that shares a group with the paginated results so
          // groups (book or replica) appear complete in the UI — covers, mdds,
          // etc. that wouldn't match a search filter still ride along.
          // IMPORTANT: We don't apply the search filter here.
          const bookHashes = Array.from(
            new Set((files || []).map((f) => f.book_hash).filter((hash): hash is string => !!hash)),
          );
          const replicaIds = Array.from(
            new Set((files || []).map((f) => f.replica_id).filter((id): id is string => !!id)),
          );
          let allRelatedFiles = files || [];
          if (bookHashes.length > 0 || replicaIds.length > 0) {
            const baseQuery = () =>
              supabase
                .from('files')
                .select(
                  'file_key, file_size, book_hash, replica_kind, replica_id, created_at, updated_at',
                )
                .eq('user_id', user.id)
                .is('deleted_at', null);

            const fileMap = new Map(allRelatedFiles.map((f) => [f.file_key, f]));
            if (bookHashes.length > 0) {
              const { data, error } = await baseQuery().in('book_hash', bookHashes);
              if (!error && data) data.forEach((f) => fileMap.set(f.file_key, f));
            }
            if (replicaIds.length > 0) {
              const { data, error } = await baseQuery().in('replica_id', replicaIds);
              if (!error && data) data.forEach((f) => fileMap.set(f.file_key, f));
            }
            allRelatedFiles = Array.from(fileMap.values());
          }

          const response: ListFilesResponse = {
            files: allRelatedFiles,
            total,
            page,
            pageSize,
            totalPages,
          };

          return Response.json(response);
        } catch (error) {
          console.error(error);
          return Response.json({ error: 'Something went wrong' }, { status: 500 });
        }
      },
    },
  },
});
