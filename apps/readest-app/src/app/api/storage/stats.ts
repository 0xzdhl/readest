import { createFileRoute } from '@tanstack/react-router';
import { and, count, desc, eq, isNull, sql, sum } from 'drizzle-orm';
import { files } from '@/db/schema';
import { getStoragePlanData } from '@/libs/server/storage-plan';
import { rlsMiddleware } from '@/middlewares/rls';

interface StorageStats {
  totalFiles: number;
  totalSize: number;
  usage: number;
  quota: number;
  usagePercentage: number;
  byBookHash: Array<{
    bookHash: string | null;
    fileCount: number;
    totalSize: number;
  }>;
}

/**
 * GET /api/storage/stats — owner-only. Aggregate counts + per-book breakdown.
 */
export const Route = createFileRoute('/api/storage/stats')({
  server: {
    middleware: [rlsMiddleware],
    handlers: {
      GET: async ({ context }) => {
        const { user, tx } = context;
        try {
          const where = and(eq(files.userId, user.id), isNull(files.deletedAt));

          const [totalsRow] = await tx
            .select({
              totalFiles: count(),
              totalSize: sum(files.fileSize),
            })
            .from(files)
            .where(where);

          const totalFiles = Number(totalsRow?.totalFiles ?? 0);
          // `sum()` returns string | null from postgres-js to preserve bigint
          // precision; coerce to a JS number for the JSON wire.
          const totalSize = Number(totalsRow?.totalSize ?? 0);

          const { usage, quota } = getStoragePlanData(user);
          const usagePercentage = quota > 0 ? Math.round((usage / quota) * 100) : 0;

          const groupedRows = await tx
            .select({
              bookHash: files.bookHash,
              fileCount: count(),
              totalSize: sum(files.fileSize),
            })
            .from(files)
            .where(where)
            .groupBy(files.bookHash)
            .orderBy(desc(sql<number>`sum(${files.fileSize})`));

          const byBookHash = groupedRows.map((row) => ({
            bookHash: row.bookHash,
            fileCount: Number(row.fileCount),
            totalSize: Number(row.totalSize ?? 0),
          }));

          const response: StorageStats = {
            totalFiles,
            totalSize,
            usage,
            quota,
            usagePercentage,
            byBookHash,
          };
          return Response.json(response);
        } catch (error) {
          console.error('Error querying storage stats:', error);
          return Response.json(
            { error: 'Failed to retrieve storage statistics' },
            { status: 500 },
          );
        }
      },
    },
  },
});
