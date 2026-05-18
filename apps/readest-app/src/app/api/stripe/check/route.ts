import Stripe from 'stripe';
import { createFileRoute } from '@tanstack/react-router';
import {
  getStripe,
  createOrUpdatePayment,
  createOrUpdateSubscription,
} from '@/libs/payment/stripe/server';
import { validateUserAndToken } from '@/utils/access';

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

export const Route = createFileRoute('/api/stripe/check')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const body = parseStripeCheckRequest(await request.json());
        if (!body) {
          return Response.json({ error: 'Session ID required' }, { status: 400 });
        }

        const { user, token } = await validateUserAndToken(request.headers.get('authorization'));
        if (!user || !token) {
          return Response.json({ error: 'Not authenticated' }, { status: 403 });
        }

        try {
          const stripe = getStripe();
          const session = await stripe.checkout.sessions.retrieve(body.sessionId);

          const customerId = session.customer as string;
          if (session.payment_status === 'paid' && session.subscription) {
            await createOrUpdateSubscription(user.id, customerId, session.subscription as string);
          } else if (session.payment_status === 'paid' && session.payment_intent) {
            await createOrUpdatePayment(user.id, customerId, body.sessionId);
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
