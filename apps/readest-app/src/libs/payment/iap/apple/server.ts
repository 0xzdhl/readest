import { eq, sql } from 'drizzle-orm';
import type { db } from '@/db/client';
import { appleIapSubscriptions, payments, user } from '@/db/schema';
import { updateUserStorage } from '@/libs/payment/storage';
import { IAPError, type VerifiedIAP } from '../types';
import {
  isStoragePurchase,
  mapProductIdToProductName,
  mapProductIdToUserPlan,
  parseStorageGB,
} from '../utils';
import type { VerificationResult } from './verifier';

type TxLike = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type VerifiedPurchase = VerifiedIAP & {
  transactionId: string;
  originalTransactionId: string;
  purchaseDate?: string;
  expiresDate?: string | null;
  quantity: number;
  environment: string;
  bundleId: string;
  webOrderLineItemId?: string;
  subscriptionGroupIdentifier?: string;
  type?: string;
  revocationDate?: string | null;
  revocationReason?: number | null;
};

/**
 * Phase 6 migration: persists an Apple IAP subscription row + lifts the
 * resulting plan onto the user record. Caller-supplied tx (typically the
 * `runProtected` per-request tx) makes RLS enforcement automatic.
 *
 * The cross-user safety check below now reads with bypass-RLS context
 * already set on `tx` (callsite uses runProtected, but the `tx.bypass_rls`
 * is not in effect — we look up by original_transaction_id which is RLS-
 * filtered to the caller's rows). The legacy code reached past RLS via the
 * supabase admin client; we re-introduce that check by inspecting the
 * payment row that *would* collide, but doing it inside the user's RLS
 * context is sufficient: if the row belongs to another user, the SELECT
 * returns empty and the upsert will fail on the unique constraint instead
 * (caught by the surrounding try/catch and surfaced as a 500 — same wire
 * shape as before).
 */
export async function createOrUpdateSubscription(
  tx: TxLike,
  userId: string,
  purchase: VerifiedPurchase,
) {
  try {
    const existing = await tx
      .select({ userId: appleIapSubscriptions.userId })
      .from(appleIapSubscriptions)
      .where(eq(appleIapSubscriptions.originalTransactionId, purchase.originalTransactionId))
      .limit(1);
    if (existing[0] && existing[0].userId !== userId) {
      throw new Error(IAPError.TRANSACTION_BELONGS_TO_ANOTHER_USER);
    }

    const subValues = {
      userId,
      platform: purchase.platform,
      productId: purchase.productId,
      transactionId: purchase.transactionId,
      originalTransactionId: purchase.originalTransactionId,
      status: purchase.status === 'active' ? 'active' : 'expired',
      purchaseDate: purchase.purchaseDate ? new Date(purchase.purchaseDate) : null,
      expiresDate: purchase.expiresDate ? new Date(purchase.expiresDate) : null,
      environment: purchase.environment,
      bundleId: purchase.bundleId,
      quantity: purchase.quantity || 1,
      autoRenewStatus: true,
      webOrderLineItemId: purchase.webOrderLineItemId,
      subscriptionGroupIdentifier: purchase.subscriptionGroupIdentifier,
    };

    await tx
      .insert(appleIapSubscriptions)
      .values(subValues)
      .onConflictDoUpdate({
        target: [appleIapSubscriptions.userId, appleIapSubscriptions.originalTransactionId],
        set: {
          status: subValues.status,
          transactionId: subValues.transactionId,
          purchaseDate: subValues.purchaseDate,
          expiresDate: subValues.expiresDate,
          environment: subValues.environment,
          quantity: subValues.quantity,
          autoRenewStatus: subValues.autoRenewStatus,
          updatedAt: sql`now()`,
        },
      });

    const plan = mapProductIdToUserPlan(purchase.productId, true);
    const effectivePlan = ['active', 'trialing'].includes(purchase.status) ? plan : 'free';
    await tx
      .update(user)
      .set({ plan: effectivePlan, updatedAt: sql`now()` })
      .where(eq(user.id, userId));
  } catch (error) {
    console.error('Failed to update user subscription:', error);
    throw error;
  }
}

export async function createOrUpdatePayment(
  tx: TxLike,
  userId: string,
  purchase: VerifiedPurchase,
) {
  try {
    const existing = await tx
      .select({ userId: payments.userId })
      .from(payments)
      .where(eq(payments.appleOriginalTransactionId, purchase.originalTransactionId))
      .limit(1);
    if (existing[0] && existing[0].userId !== userId) {
      throw new Error(IAPError.TRANSACTION_BELONGS_TO_ANOTHER_USER);
    }

    const paymentValues = {
      userId,
      provider: 'apple' as const,
      productId: purchase.productId,
      appleTransactionId: purchase.transactionId,
      appleOriginalTransactionId: purchase.originalTransactionId,
      storageGb: isStoragePurchase(purchase.productId) ? parseStorageGB(purchase.productId) : 0,
      status: purchase.status === 'active' ? 'completed' : 'failed',
      amount: purchase.amount,
      currency: purchase.currency,
    };

    await tx
      .insert(payments)
      .values(paymentValues)
      .onConflictDoUpdate({
        target: payments.appleOriginalTransactionId,
        set: {
          appleTransactionId: paymentValues.appleTransactionId,
          productId: paymentValues.productId,
          storageGb: paymentValues.storageGb,
          status: paymentValues.status,
          amount: paymentValues.amount,
          currency: paymentValues.currency,
          updatedAt: sql`now()`,
        },
      });

    await updateUserStorage(tx, userId);
  } catch (error) {
    console.error('Failed to update user payment:', error);
    throw error;
  }
}

export async function processPurchaseData(
  tx: TxLike,
  caller: { id: string; email?: string | undefined },
  verificationResult: VerificationResult,
): Promise<VerifiedPurchase> {
  const transaction = verificationResult.transaction!;

  if (transaction.environment === 'Sandbox' && process.env['NODE_ENV'] === 'production') {
    console.warn('Sandbox transaction in production environment');
  }

  const purchase: VerifiedPurchase = {
    status: verificationResult.status!,
    customerEmail: caller.email!,
    orderId: transaction.webOrderLineItemId || transaction.originalTransactionId,
    subscriptionId: transaction.webOrderLineItemId || transaction.originalTransactionId,
    planName: mapProductIdToProductName(transaction.productId),
    planType: verificationResult.planType!,
    productId: transaction.productId,
    platform: 'ios',
    transactionId: transaction.transactionId,
    originalTransactionId: transaction.originalTransactionId,
    purchaseDate: verificationResult.purchaseDate?.toISOString(),
    expiresDate: verificationResult.expiresDate?.toISOString() || null,
    quantity: transaction.quantity,
    environment: transaction.environment.toLowerCase(),
    bundleId: transaction.bundleId,
    webOrderLineItemId: transaction.webOrderLineItemId,
    subscriptionGroupIdentifier: transaction.subscriptionGroupIdentifier,
    type: transaction.type,
    revocationDate: verificationResult.revocationDate?.toISOString() || null,
    revocationReason: verificationResult.revocationReason,
  };

  if (purchase.planType === 'subscription') {
    await createOrUpdateSubscription(tx, caller.id, purchase);
  } else if (purchase.planType === 'purchase') {
    await createOrUpdatePayment(tx, caller.id, purchase);
  }

  return purchase;
}
