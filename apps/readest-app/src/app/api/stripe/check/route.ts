import { createFileRoute } from '@tanstack/react-router';
import Stripe from 'stripe';
import {
  createOrUpdatePayment,
  createOrUpdateSubscription,
  getStripe,
} from '@/libs/payment/stripe/server';
import { rlsMiddleware } from '@/middlewares/rls';

interface StripeCheckRequest {
  sessionId: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const parseStripeCheckRequest = (body: unknown): StripeCheckRequest | null => {
  if (!isRecord(body) || typeof body['sessionId'] !== 'string' || !body['sessionId']) {
    return null;
  }
  return { sessionId: body['sessionId'] };
};

/**
 * Owner-only callback that polls Stripe for the final state of a checkout
 * session (used by the `/user/subscription/success` redirect page).
 */
export const Route = createFileRoute('/api/stripe/check')({
  server: {
    middleware: [rlsMiddleware],
    handlers: {
      POST: async ({ request, context }) => {
        const { user, tx } = context;
        const parsed = parseStripeCheckRequest(await request.json());
        if (!parsed) {
          return Response.json({ error: 'Session ID required' }, { status: 400 });
        }
        try {
          const stripe = getStripe();
          const session = await stripe.checkout.sessions.retrieve(parsed.sessionId);

          const customerId = session.customer as string;
          if (session.payment_status === 'paid' && session.subscription) {
            await createOrUpdateSubscription(
              tx,
              user.id,
              customerId,
              session.subscription as string,
            );
          } else if (session.payment_status === 'paid' && session.payment_intent) {
            await createOrUpdatePayment(tx, user.id, customerId, parsed.sessionId);
          }

          return Response.json({ session });
        } catch (error) {
          if (error instanceof Stripe.errors.StripeError) {
            console.error('Stripe error:', error);
            return Response.json({ error: error.message }, { status: 500 });
          }
          return Response.json(
            { error: error instanceof Error ? error.message : 'Unknown error' },
            { status: 500 },
          );
        }
      },
    },
  },
});
