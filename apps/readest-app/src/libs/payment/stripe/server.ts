import { eq, sql } from 'drizzle-orm';
import Stripe from 'stripe';
import type { db } from '@/db/client';
import { payments, subscriptions, user } from '@/db/schema';
import { env } from '@/env';
import type { PaymentStatus, StripeProductMetadata } from '@/types/payment';
import type { UserPlan } from '@/types/quota';
import { updateUserStorage } from '../storage';

type TxLike = Parameters<Parameters<typeof db.transaction>[0]>[0];

let stripe: Stripe | null;

export const getStripe = () => {
  if (!stripe) {
    const stripeSecretKey =
      env.NODE_ENV === 'production' ? env.STRIPE_SECRET_KEY : env.STRIPE_SECRET_KEY_DEV;
    stripe = new Stripe(stripeSecretKey!, {
      httpClient: Stripe.createFetchHttpClient(),
    });
  }
  return stripe;
};

/**
 * Phase 6 of the supabase→better-auth migration: this used to grab its own
 * supabase admin client; it now takes the RLS-scoped tx from the caller
 * (`runService` for webhook callsites, `runProtected` for user-facing
 * routes). The legacy `plans` table is gone — plan/status now live on the
 * `user` row directly.
 */
export const createOrUpdateSubscription = async (
  tx: TxLike,
  userId: string,
  customerId: string,
  subscriptionId: string,
) => {
  const stripe = getStripe();

  const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
    expand: ['items.data.price.product'],
  });
  const subscriptionItem = subscription.items.data[0]!;
  const priceId = subscriptionItem.price.id;
  const product = subscriptionItem.price.product as Stripe.Product & {
    metadata: StripeProductMetadata;
  };
  const plan = product.metadata?.plan || 'free';

  try {
    const existing = await tx
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.stripeSubscriptionId, subscriptionId))
      .limit(1);

    const periodStart = new Date(subscriptionItem.current_period_start * 1000);
    const periodEnd = new Date(subscriptionItem.current_period_end * 1000);
    if (existing[0]) {
      await tx
        .update(subscriptions)
        .set({
          status: subscription.status,
          currentPeriodStart: periodStart,
          currentPeriodEnd: periodEnd,
        })
        .where(eq(subscriptions.id, existing[0].id));
    } else {
      await tx.insert(subscriptions).values({
        userId,
        stripeCustomerId: customerId,
        stripeSubscriptionId: subscriptionId,
        stripePriceId: priceId,
        status: subscription.status,
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
      });
    }
  } catch (error) {
    console.error('Error checking existing subscription:', error);
  }

  const effectivePlan: UserPlan = ['active', 'trialing'].includes(subscription.status)
    ? ((plan as UserPlan) ?? 'free')
    : 'free';
  await tx
    .update(user)
    .set({ plan: effectivePlan, updatedAt: sql`now()` })
    .where(eq(user.id, userId));
};

export const createOrUpdatePayment = async (
  tx: TxLike,
  userId: string,
  customerId: string,
  checkoutSessionId: string,
) => {
  const stripe = getStripe();

  const session = await stripe.checkout.sessions.retrieve(checkoutSessionId, {
    expand: ['line_items.data.price.product', 'payment_intent'],
  });

  if (!session.payment_intent) {
    throw new Error('No payment intent in checkout session');
  }

  const paymentIntent = session.payment_intent as Stripe.PaymentIntent;
  const lineItem = session.line_items?.data[0];
  const product = lineItem?.price?.product as Stripe.Product & {
    metadata: { plan: UserPlan; storageGB: string };
  };
  const productMetadata = product?.metadata;

  try {
    const storageGb = productMetadata?.storageGB ? parseInt(productMetadata.storageGB, 10) : 0;
    const paymentValues = {
      userId,
      provider: 'stripe' as const,
      stripeCustomerId: customerId,
      stripeCheckoutId: checkoutSessionId,
      stripePaymentIntentId: paymentIntent.id,
      amount: paymentIntent.amount,
      currency: paymentIntent.currency,
      status: paymentIntent.status as PaymentStatus,
      paymentMethod: paymentIntent.payment_method as string | null,
      productId: product?.id,
      storageGb,
      metadata: product?.metadata as Record<string, unknown> | undefined,
    };

    await tx
      .insert(payments)
      .values(paymentValues)
      .onConflictDoUpdate({
        target: payments.stripePaymentIntentId,
        set: {
          amount: paymentValues.amount,
          currency: paymentValues.currency,
          status: paymentValues.status,
          paymentMethod: paymentValues.paymentMethod,
          productId: paymentValues.productId,
          storageGb: paymentValues.storageGb,
          metadata: paymentValues.metadata,
          updatedAt: sql`now()`,
        },
      });

    await updateUserStorage(tx, userId);
  } catch (error) {
    console.error('Error creating or updating payment:', error);
    throw error;
  }
};
