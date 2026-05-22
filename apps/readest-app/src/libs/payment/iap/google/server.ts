import { eq, sql } from 'drizzle-orm';
import type { db } from '@/db/client';
import { googleIapSubscriptions, payments, user } from '@/db/schema';
import { updateUserStorage } from '@/libs/payment/storage';
import { IAPError, type VerifiedIAP } from '../types';
import {
  isStoragePurchase,
  mapProductIdToProductName,
  mapProductIdToUserPlan,
  parseStorageGB,
} from '../utils';
import type {
  ProductPurchase,
  SubscriptionPurchase,
  VerificationResult,
  VerifyPurchaseParams,
} from './verifier';

type TxLike = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type VerifiedPurchase = VerifiedIAP & {
  purchaseToken: string;
  purchaseDate?: string;
  expiresDate?: string | null;
  quantity: number;
  environment: string;
  packageName: string;
  purchaseState?: number | null;
  acknowledgementState?: number | null;
  autoRenewing?: boolean | null;
  priceAmountMicros?: string | null;
  priceCurrencyCode?: string | null;
  countryCode?: string | null;
  developerPayload?: string | null;
  linkedPurchaseToken?: string | null;
  obfuscatedExternalAccountId?: string | null;
  obfuscatedExternalProfileId?: string | null;
  cancelReason?: number | null;
  userCancellationTimeMillis?: string | null;
};

/**
 * Phase 6 migration: persists a Google Play IAP subscription row and lifts
 * the resulting plan onto the user record. Caller supplies the tx (route
 * uses `runProtected`, RLS pinned to the caller's user id).
 */
export async function createOrUpdateSubscription(
  tx: TxLike,
  userId: string,
  purchase: VerifiedPurchase,
) {
  try {
    const existing = await tx
      .select({ userId: googleIapSubscriptions.userId })
      .from(googleIapSubscriptions)
      .where(eq(googleIapSubscriptions.purchaseToken, purchase.purchaseToken))
      .limit(1);
    if (existing[0] && existing[0].userId !== userId) {
      throw new Error(IAPError.TRANSACTION_BELONGS_TO_ANOTHER_USER);
    }

    const subValues = {
      userId,
      platform: purchase.platform,
      productId: purchase.productId,
      purchaseToken: purchase.purchaseToken,
      orderId: purchase.orderId,
      status: purchase.status === 'active' ? 'active' : 'expired',
      purchaseDate: purchase.purchaseDate ? new Date(purchase.purchaseDate) : null,
      expiresDate: purchase.expiresDate ? new Date(purchase.expiresDate) : null,
      environment: purchase.environment,
      packageName: purchase.packageName,
      quantity: purchase.quantity || 1,
      autoRenewStatus: purchase.autoRenewing || false,
      purchaseState: purchase.purchaseState ?? null,
      acknowledgementState: purchase.acknowledgementState ?? null,
      priceAmountMicros: purchase.priceAmountMicros ?? null,
      priceCurrencyCode: purchase.priceCurrencyCode ?? null,
      countryCode: purchase.countryCode ?? null,
      developerPayload: purchase.developerPayload ?? null,
      linkedPurchaseToken: purchase.linkedPurchaseToken ?? null,
      obfuscatedExternalAccountId: purchase.obfuscatedExternalAccountId ?? null,
      obfuscatedExternalProfileId: purchase.obfuscatedExternalProfileId ?? null,
      cancelReason: purchase.cancelReason ?? null,
      userCancellationTimeMillis: purchase.userCancellationTimeMillis ?? null,
    };

    await tx
      .insert(googleIapSubscriptions)
      .values(subValues)
      .onConflictDoUpdate({
        target: [googleIapSubscriptions.userId, googleIapSubscriptions.orderId],
        set: {
          status: subValues.status,
          purchaseToken: subValues.purchaseToken,
          purchaseDate: subValues.purchaseDate,
          expiresDate: subValues.expiresDate,
          environment: subValues.environment,
          quantity: subValues.quantity,
          autoRenewStatus: subValues.autoRenewStatus,
          purchaseState: subValues.purchaseState,
          acknowledgementState: subValues.acknowledgementState,
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
      .where(eq(payments.googlePurchaseToken, purchase.purchaseToken))
      .limit(1);
    if (existing[0] && existing[0].userId !== userId) {
      throw new Error(IAPError.TRANSACTION_BELONGS_TO_ANOTHER_USER);
    }

    const paymentValues = {
      userId,
      provider: 'google' as const,
      productId: purchase.productId,
      googleOrderId: purchase.orderId,
      googlePurchaseToken: purchase.purchaseToken,
      storageGb: isStoragePurchase(purchase.productId) ? parseStorageGB(purchase.productId) : 0,
      status: purchase.status === 'active' ? 'completed' : 'failed',
      amount: purchase.amount,
      currency: purchase.currency,
    };

    await tx
      .insert(payments)
      .values(paymentValues)
      .onConflictDoUpdate({
        target: payments.googlePurchaseToken,
        set: {
          googleOrderId: paymentValues.googleOrderId,
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
  verifyParams: VerifyPurchaseParams,
  verificationResult: VerificationResult,
): Promise<VerifiedPurchase> {
  const { orderId, purchaseToken, productId, packageName } = verifyParams;
  const purchaseData = verificationResult.purchaseData!;
  const isSubscription = verificationResult.purchaseType === 'subscription';

  // Check environment (test purchases have specific patterns in orderId)
  const isTestPurchase = purchaseData.purchaseType === 0; // 0 = Test, 1 = Promo, undefined = Real
  if (isTestPurchase && process.env['NODE_ENV'] === 'production') {
    console.warn('Test purchase in production environment');
  }

  let purchase: VerifiedPurchase;
  if (isSubscription) {
    const subData = purchaseData as SubscriptionPurchase;
    purchase = {
      platform: 'android',
      status: verificationResult.status!,
      customerEmail: caller.email!,
      orderId: subData.orderId || orderId,
      subscriptionId: subData.orderId || orderId,
      planName: mapProductIdToProductName(productId),
      planType: 'subscription',
      productId: productId,
      amount: subData.priceAmountMicros ? Number(subData.priceAmountMicros) / 10000 : undefined,
      currency: subData.priceCurrencyCode || undefined,
      purchaseToken: purchaseToken,
      purchaseDate: verificationResult.purchaseDate?.toISOString(),
      expiresDate: verificationResult.expiresDate?.toISOString() || null,
      quantity: subData.quantity || 1,
      environment: isTestPurchase ? 'sandbox' : 'production',
      packageName: packageName,
      purchaseState: subData.purchaseState,
      acknowledgementState: subData.acknowledgementState,
      autoRenewing: subData.autoRenewing,
      priceAmountMicros: subData.priceAmountMicros,
      priceCurrencyCode: subData.priceCurrencyCode,
      countryCode: subData.countryCode,
      developerPayload: subData.developerPayload,
      linkedPurchaseToken: subData.linkedPurchaseToken,
      obfuscatedExternalAccountId: subData.obfuscatedExternalAccountId,
      obfuscatedExternalProfileId: subData.obfuscatedExternalProfileId,
      cancelReason: subData.cancelReason,
      userCancellationTimeMillis: subData.userCancellationTimeMillis,
    };
  } else {
    const prodData = purchaseData as ProductPurchase;
    purchase = {
      platform: 'android',
      status: verificationResult.status!,
      customerEmail: caller.email!,
      orderId: prodData.orderId || purchaseToken,
      subscriptionId: prodData.orderId || purchaseToken,
      planName: mapProductIdToProductName(productId),
      planType: 'purchase',
      productId: productId,
      purchaseToken: purchaseToken,
      purchaseDate: verificationResult.purchaseDate?.toISOString(),
      expiresDate: null, // One-time purchases don't expire
      quantity: prodData.quantity || 1,
      environment: isTestPurchase ? 'sandbox' : 'production',
      packageName: packageName,
      purchaseState: prodData.purchaseState,
      acknowledgementState: prodData.acknowledgementState,
      autoRenewing: false, // Not applicable for one-time purchases
      priceAmountMicros: undefined,
      priceCurrencyCode: prodData.regionCode,
      countryCode: prodData.regionCode,
      developerPayload: prodData.developerPayload,
      linkedPurchaseToken: undefined,
      obfuscatedExternalAccountId: prodData.obfuscatedExternalAccountId,
      obfuscatedExternalProfileId: prodData.obfuscatedExternalProfileId,
      cancelReason: null,
      userCancellationTimeMillis: null,
    };
  }

  if (isSubscription) {
    await createOrUpdateSubscription(tx, caller.id, purchase);
  } else {
    await createOrUpdatePayment(tx, caller.id, purchase);
  }

  return purchase;
}
