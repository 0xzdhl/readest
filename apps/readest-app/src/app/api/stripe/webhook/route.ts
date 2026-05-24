import { createFileRoute } from '@tanstack/react-router';
import { eq, sql } from 'drizzle-orm';
import type Stripe from 'stripe';
import type { DbTransaction } from '@/db/client';
import { customers, subscriptions, user } from '@/db/schema';
import { env } from '@/env';
import {
  createOrUpdatePayment,
  createOrUpdateSubscription,
  getStripe,
} from '@/libs/payment/stripe/server';
import { runService } from '@/libs/server/route-helpers';

type TxLike = Parameters<Parameters<DbTransaction>[0]>[0];

/**
 * Phase 6 of the supabase→better-auth migration. Stripe webhook lives on
 * `runService` (RLS bypassed) because there's no end-user session — its own
 * authenticity is established by the Stripe signature check, which still
 * runs BEFORE any DB write. If signature verification fails, we short-circuit
 * with 400 and never open the bypass-RLS transaction, so a forged request
 * cannot mutate state.
 */
export const Route = createFileRoute('/api/stripe/webhook')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const body = await request.text();
        const signature = request.headers.get('stripe-signature');

        if (!signature) {
          return Response.json({ error: 'Missing Stripe signature' }, { status: 401 });
        }

        const stripe = getStripe();
        let event: Stripe.Event;
        try {
          event = stripe.webhooks.constructEvent(body, signature, env.STRIPE_WEBHOOK_SECRET!);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Unknown error';
          console.error(`Webhook signature verification failed: ${message}`);
          return Response.json(
            { error: `Webhook signature verification failed: ${message}` },
            { status: 400 },
          );
        }

        return runService(async ({ tx }) => {
          try {
            switch (event.type) {
              case 'checkout.session.completed': {
                const session = event.data.object;
                const userId = session.metadata?.['userId'];
                if (userId) {
                  const customerId = session.customer as string;
                  if (session.mode === 'subscription' && session.subscription) {
                    await createOrUpdateSubscription(
                      tx,
                      userId,
                      customerId,
                      session.subscription as string,
                    );
                  } else if (session.id) {
                    await createOrUpdatePayment(tx, userId, customerId, session.id);
                  }
                }
                break;
              }

              case 'invoice.payment_succeeded':
                await handleSuccessfulInvoice(tx, event.data.object);
                break;

              case 'invoice.payment_failed':
                await handleFailedInvoice(tx, event.data.object);
                break;

              case 'customer.subscription.updated':
                await handleSubscriptionUpdated(tx, event.data.object);
                break;

              case 'customer.subscription.deleted':
                await handleSubscriptionCancelled(tx, event.data.object);
                break;
            }

            return Response.json({ received: true });
          } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            console.error('Webhook error:', message);
            return Response.json({ error: message }, { status: 500 });
          }
        });
      },
    },
  },
});

async function handleSuccessfulInvoice(tx: TxLike, invoice: Stripe.Invoice) {
  const customerId = invoice.customer;
  const subscriptionId = invoice.parent?.subscription_details?.subscription;

  if (!subscriptionId || typeof customerId !== 'string') {
    return;
  }
  const subscriptionIdStr = subscriptionId as string;

  const customerRow = await tx
    .select({ userId: customers.userId })
    .from(customers)
    .where(eq(customers.stripeCustomerId, customerId))
    .limit(1);

  if (!customerRow[0]) {
    console.error('Customer not found:', customerId);
    return;
  }

  await tx
    .update(subscriptions)
    .set({
      status: 'active',
      currentPeriodEnd: new Date(invoice.lines.data[0]!.period.end * 1000),
    })
    .where(eq(subscriptions.stripeSubscriptionId, subscriptionIdStr));

  // Legacy semantics: invoice payment succeeded ⇒ user plan stays "active"
  // (the plan itself was set on subscription creation; we just bump status
  // via updatedAt so downstream listeners notice).
  await tx
    .update(user)
    .set({ updatedAt: sql`now()` })
    .where(eq(user.id, customerRow[0].userId));
}

async function handleFailedInvoice(tx: TxLike, invoice: Stripe.Invoice) {
  const customerId = invoice.customer;
  const subscriptionId = invoice.parent?.subscription_details?.subscription;

  if (!subscriptionId || typeof customerId !== 'string') {
    return;
  }
  const subscriptionIdStr = subscriptionId as string;

  const customerRow = await tx
    .select({ userId: customers.userId })
    .from(customers)
    .where(eq(customers.stripeCustomerId, customerId))
    .limit(1);

  if (!customerRow[0]) {
    console.error('Customer not found:', customerId);
    return;
  }

  await tx
    .update(subscriptions)
    .set({ status: 'past_due' })
    .where(eq(subscriptions.stripeSubscriptionId, subscriptionIdStr));

  // Demote plan back to free on failed renewal (pre-migration behavior:
  // plans.status was set to 'past_due'; we now reflect that on the user row).
  await tx
    .update(user)
    .set({ plan: 'free', updatedAt: sql`now()` })
    .where(eq(user.id, customerRow[0].userId));
}

async function handleSubscriptionUpdated(tx: TxLike, subscription: Stripe.Subscription) {
  const subscriptionId = subscription.id;

  const row = await tx
    .select({ userId: subscriptions.userId, stripeCustomerId: subscriptions.stripeCustomerId })
    .from(subscriptions)
    .where(eq(subscriptions.stripeSubscriptionId, subscriptionId))
    .limit(1);

  if (!row[0] || !row[0].stripeCustomerId) {
    console.error('Subscription not found:', subscriptionId);
    return;
  }
  await createOrUpdateSubscription(tx, row[0].userId, row[0].stripeCustomerId, subscriptionId);
}

async function handleSubscriptionCancelled(tx: TxLike, subscription: Stripe.Subscription) {
  const subscriptionId = subscription.id;

  await tx
    .update(subscriptions)
    .set({ status: 'cancelled', cancelledAt: new Date() })
    .where(eq(subscriptions.stripeSubscriptionId, subscriptionId));

  const row = await tx
    .select({ userId: subscriptions.userId })
    .from(subscriptions)
    .where(eq(subscriptions.stripeSubscriptionId, subscriptionId))
    .limit(1);

  if (row[0]?.userId) {
    await tx
      .update(user)
      .set({ plan: 'free', updatedAt: sql`now()` })
      .where(eq(user.id, row[0].userId));
  }
}
