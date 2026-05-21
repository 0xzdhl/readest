import { createFileRoute } from '@tanstack/react-router';
import { and, asc, count, desc, eq, ilike, inArray, isNull, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { files } from '@/db/schema';
import { runProtected } from '@/libs/server/route-helpers';

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

const toIsoOrNull = (d: Date | string | null | undefined): string | null =>
  d == null ? null : d instanceof Date ? d.toISOString() : d;

/**
 * GET /api/storage/list — owner-only, paginated. Phase 5 swaps supabase for
 * drizzle. The fan-out "include every sibling file in the matched groups"
 * pass is preserved so library UIs see complete book/replica groups even
 * when a search filter only matched a subset.
 */
export const Route = createFileRoute('/api/storage/list')({
  server: {
    handlers: {
      GET: async ({ request }) =>
        runProtected(request, async ({ user, tx }) => {
          try {
            const url = new URL(request.url);
            const page = parseInt(url.searchParams.get('page') || '') || 1;
            const pageSize = Math.min(
              parseInt(url.searchParams.get('pageSize') || '') || 50,
              100,
            );
            const sortBy = url.searchParams.get('sortBy') || 'created_at';
            const sortOrder = url.searchParams.get('sortOrder') === 'asc' ? 'asc' : 'desc';
            const bookHash = url.searchParams.get('bookHash') || undefined;
            const search = url.searchParams.get('search') || undefined;

            const baseWhere: SQL[] = [eq(files.userId, user.id), isNull(files.deletedAt)];
            if (bookHash) {
              baseWhere.push(eq(files.bookHash, bookHash));
            }
            if (search) {
              baseWhere.push(ilike(files.fileKey, `%${search}%`));
            }

            // Map sortBy to drizzle column. Whitelist mirrors the legacy
            // supabase route's allow-list verbatim so a malformed sortBy
            // param falls back to `created_at` rather than erroring.
            const sortColumnMap: Record<string, PgColumn> = {
              created_at: files.createdAt,
              updated_at: files.updatedAt,
              file_size: files.fileSize,
              file_key: files.fileKey,
            };
            const sortColumn = sortColumnMap[sortBy] ?? files.createdAt;
            const orderBy = sortOrder === 'asc' ? asc(sortColumn) : desc(sortColumn);

            const from = (page - 1) * pageSize;

            const [pageRows, totalRows] = await Promise.all([
              tx
                .select({
                  fileKey: files.fileKey,
                  fileSize: files.fileSize,
                  bookHash: files.bookHash,
                  replicaKind: files.replicaKind,
                  replicaId: files.replicaId,
                  createdAt: files.createdAt,
                  updatedAt: files.updatedAt,
                })
                .from(files)
                .where(and(...baseWhere))
                .orderBy(orderBy)
                .limit(pageSize)
                .offset(from),
              tx
                .select({ value: count() })
                .from(files)
                .where(and(...baseWhere)),
            ]);

            const total = totalRows[0]?.value ?? 0;
            const totalPages = Math.ceil(total / pageSize);

            // Pull every file that shares a group (book or replica) with the
            // paginated results so the UI sees complete groups — covers,
            // metadata sidecars, etc. that the search filter wouldn't match.
            // Mirrors the legacy fan-out and intentionally drops the search
            // filter for the fan-out queries.
            const bookHashes = Array.from(
              new Set(
                pageRows
                  .map((f) => f.bookHash)
                  .filter((hash): hash is string => !!hash),
              ),
            );
            const replicaIds = Array.from(
              new Set(
                pageRows
                  .map((f) => f.replicaId)
                  .filter((id): id is string => !!id),
              ),
            );

            const fileMap = new Map<string, (typeof pageRows)[number]>(
              pageRows.map((f) => [f.fileKey, f]),
            );

            const fanoutBase = and(eq(files.userId, user.id), isNull(files.deletedAt));
            if (bookHashes.length > 0) {
              const extras = await tx
                .select({
                  fileKey: files.fileKey,
                  fileSize: files.fileSize,
                  bookHash: files.bookHash,
                  replicaKind: files.replicaKind,
                  replicaId: files.replicaId,
                  createdAt: files.createdAt,
                  updatedAt: files.updatedAt,
                })
                .from(files)
                .where(and(fanoutBase, inArray(files.bookHash, bookHashes)));
              extras.forEach((f) => fileMap.set(f.fileKey, f));
            }
            if (replicaIds.length > 0) {
              const extras = await tx
                .select({
                  fileKey: files.fileKey,
                  fileSize: files.fileSize,
                  bookHash: files.bookHash,
                  replicaKind: files.replicaKind,
                  replicaId: files.replicaId,
                  createdAt: files.createdAt,
                  updatedAt: files.updatedAt,
                })
                .from(files)
                .where(and(fanoutBase, inArray(files.replicaId, replicaIds)));
              extras.forEach((f) => fileMap.set(f.fileKey, f));
            }

            const allRelatedFiles: FileRecord[] = Array.from(fileMap.values()).map((row) => ({
              file_key: row.fileKey,
              file_size: row.fileSize,
              book_hash: row.bookHash,
              replica_kind: row.replicaKind,
              replica_id: row.replicaId,
              created_at: toIsoOrNull(row.createdAt) ?? '',
              updated_at: toIsoOrNull(row.updatedAt),
            }));

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
        }),
    },
  },
});
