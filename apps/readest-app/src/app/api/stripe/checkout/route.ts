import { createFileRoute } from '@tanstack/react-router';
import { eq } from 'drizzle-orm';
import { customers } from '@/db/schema';
import { getStripe } from '@/libs/payment/stripe/server';
import { runProtected } from '@/libs/server/route-helpers';
import type { PlanType } from '@/types/quota';

interface StripeCheckoutRequest {
  priceId: string;
  planType: PlanType;
  embedded: boolean;
  metadata: Record<string, string>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isStringRecord = (value: unknown): value is Record<string, string> =>
  isRecord(value) && Object.values(value).every((item) => typeof item === 'string');

const parseStripeCheckoutRequest = (body: unknown): StripeCheckoutRequest | null => {
  if (!isRecord(body) || typeof body['priceId'] !== 'string' || !body['priceId']) {
    return null;
  }

  const planType = body['planType'] === 'purchase' ? 'purchase' : 'subscription';
  const embedded = typeof body['embedded'] === 'boolean' ? body['embedded'] : true;
  const metadata = body['metadata'] === undefined ? {} : body['metadata'];
  if (!isStringRecord(metadata)) {
    return null;
  }

  return {
    priceId: body['priceId'],
    planType,
    embedded,
    metadata,
  };
};

/**
 * Phase 6: owner-only — caller IS the user being charged. Looks up an
 * existing Stripe customer row (RLS-scoped) or creates one in Stripe and
 * persists the mapping, then opens a Checkout session.
 */
export const Route = createFileRoute('/api/stripe/checkout')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const parsed = parseStripeCheckoutRequest(await request.json());
        if (!parsed) {
          return Response.json({ error: 'Invalid checkout request' }, { status: 400 });
        }
        const { priceId, planType, embedded, metadata } = parsed;

        return runProtected(request, async ({ user, tx }) => {
          const enhancedMetadata = {
            ...metadata,
            userId: user.id,
          };

          try {
            const existing = await tx
              .select({ stripeCustomerId: customers.stripeCustomerId })
              .from(customers)
              .where(eq(customers.userId, user.id))
              .limit(1);

            let customerId: string;
            if (!existing[0]?.stripeCustomerId) {
              const stripe = getStripe();
              const customer = await stripe.customers.create({
                email: user.email,
                metadata: { userId: user.id },
              });
              customerId = customer.id;
              await tx.insert(customers).values({
                userId: user.id,
                stripeCustomerId: customerId,
              });
            } else {
              customerId = existing[0].stripeCustomerId;
            }

            const stripe = getStripe();
            const successUrl = `${request.headers.get('origin')}/user/subscription/success?payment=stripe&session_id={CHECKOUT_SESSION_ID}`;
            const returnUrl = `${request.headers.get('origin')}/user`;
            const session = await stripe.checkout.sessions.create({
              ui_mode: embedded ? 'embedded_page' : 'hosted_page',
              customer: customerId,
              mode: planType === 'subscription' ? 'subscription' : 'payment',
              allow_promotion_codes: true,
              line_items: [
                {
                  price: priceId,
                  quantity: 1,
                },
              ],
              metadata: enhancedMetadata,
              success_url: embedded ? undefined : successUrl,
              cancel_url: embedded ? undefined : returnUrl,
              redirect_on_completion: embedded ? 'never' : undefined,
            });

            return Response.json({
              url: session.url,
              sessionId: session.id,
              clientSecret: session.client_secret,
            });
          } catch (error) {
            console.error(error);
            return Response.json({ error: 'Error creating checkout session' }, { status: 500 });
          }
        });
      },
    },
  },
});
