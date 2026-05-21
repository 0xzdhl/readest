import { createFileRoute } from '@tanstack/react-router';
import { eq } from 'drizzle-orm';
import { customers } from '@/db/schema';
import { getStripe } from '@/libs/payment/stripe/server';
import { runProtected } from '@/libs/server/route-helpers';

/**
 * Phase 6: owner-only — caller manages their own billing portal session.
 */
export const Route = createFileRoute('/api/stripe/portal')({
  server: {
    handlers: {
      POST: async ({ request }) =>
        runProtected(request, async ({ user, tx }) => {
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
        }),
    },
  },
});
