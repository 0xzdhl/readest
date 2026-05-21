import { and, eq, inArray, sql } from 'drizzle-orm';
import { payments, user } from '@/db/schema';
import { COMPLETED_PAYMENT_STATUSES } from '@/types/payment';
import type { db } from '@/db/client';

type TxLike = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Recompute the user's purchased storage from the `payments` ledger and write
 * it back onto the `user.storagePurchasedBytes` column.
 *
 * Phase 6 of the supabase→better-auth migration: pre-migration this updated a
 * separate `plans` table; that table no longer exists — plan + storage live
 * on the `user` row directly (see `db/schema/auth.ts`). The caller owns the
 * RLS transaction (typically `runService` for webhooks or `runProtected`
 * inside a user-facing route) so this helper just reuses it.
 */
export const updateUserStorage = async (tx: TxLike, userId: string): Promise<number> => {
  const rows = await tx
    .select({ storageGb: payments.storageGb })
    .from(payments)
    .where(
      and(eq(payments.userId, userId), inArray(payments.status, COMPLETED_PAYMENT_STATUSES)),
    );

  const totalStorageGB = rows.reduce((sum, row) => sum + (row.storageGb ?? 0), 0);
  const purchasedBytes = totalStorageGB * 1024 * 1024 * 1024;

  await tx
    .update(user)
    .set({ storagePurchasedBytes: purchasedBytes, updatedAt: sql`now()` })
    .where(eq(user.id, userId));

  return totalStorageGB;
};
