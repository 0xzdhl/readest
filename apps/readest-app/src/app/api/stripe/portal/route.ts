import { createFileRoute } from '@tanstack/react-router';
import { eq } from 'drizzle-orm';
import { customers } from '@/db/schema';
import { getStripe } from '@/libs/payment/stripe/server';
import { rlsMiddleware } from '@/middlewares/rls';

/**
 * Owner-only — caller manages their own billing portal session.
 */
export const Route = createFileRoute('/api/stripe/portal')({
  server: {
    middleware: [rlsMiddleware],
    handlers: {
      POST: async ({ request, context }) => {
        const { user, tx } = context;
        try {
          const existing = await tx
            .select({ stripeCustomerId: customers.stripeCustomerId })
            .from(customers)
            .where(eq(customers.userId, user.id))
            .limit(1);

          if (!existing[0]?.stripeCustomerId) {
            throw new Error('Customer not found');
          }

          const stripe = getStripe();
          const session = await stripe.billingPortal.sessions.create({
            customer: existing[0].stripeCustomerId,
            return_url: `${request.headers.get('origin')}/user`,
          });

          return Response.json({ url: session.url });
        } catch (error) {
          console.error(error);
          return Response.json({ error: 'Error creating portal session' }, { status: 500 });
        }
      },
    },
  },
});
