import { z } from 'zod';
import { createFileRoute } from '@tanstack/react-router';
import { IAPError } from '@/libs/payment/iap/types';
import { runProtected } from '@/libs/server/route-helpers';
import { getAppleIAPVerifier } from '@/libs/payment/iap/apple/verifier';
import { processPurchaseData, type VerifiedPurchase } from '@/libs/payment/iap/apple/server';

const iapVerificationSchema = z.object({
  transactionId: z.string().min(1, 'Transaction ID is required'),
  originalTransactionId: z.string().min(1, 'Original Transaction ID is required'),
});

/**
 * Phase 6: owner-only — caller IS the user redeeming the IAP. Body parsing
 * happens up front (independent of session) so a malformed payload returns
 * 400 without bothering the auth path; once parsed, the route hands off to
 * `runProtected` which opens an RLS-scoped tx and re-shapes the 401 body
 * the way the legacy supabase route did.
 */
export const Route = createFileRoute('/api/apple/iap-verify')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let validatedInput: z.infer<typeof iapVerificationSchema>;
        try {
          validatedInput = iapVerificationSchema.parse(await request.json());
        } catch (error) {
          if (error instanceof z.ZodError) {
            return Response.json(
              { error: 'Invalid input data', purchase: null },
              { status: 400 },
            );
          }
          throw error;
        }
        const { originalTransactionId } = validatedInput;

        return runProtected(request, async ({ user, tx }) => {
          try {
            const defaultIAPVerifier = getAppleIAPVerifier();
            const verificationResult =
              await defaultIAPVerifier.verifyTransaction(originalTransactionId);
            if (!verificationResult.success) {
              console.error('Apple verification failed:', verificationResult.error);
              return Response.json(
                {
                  error: verificationResult.error || IAPError.TRANSACTION_CANNOT_BE_VERIFIED,
                  purchase: null,
                },
                { status: 400 },
              );
            }

            const transaction = verificationResult.transaction!;
            console.log('Apple verification successful:', {
              transactionId: transaction.transactionId,
              productId: transaction.productId,
              environment: transaction.environment,
            });

            try {
              const purchase: VerifiedPurchase = await processPurchaseData(
                tx,
                { id: user.id, email: user.email },
                verificationResult,
              );
              return Response.json({ purchase, error: null });
            } catch (dbError) {
              console.error('Database update failed:', dbError);
              return Response.json(
                { error: IAPError.TRANSACTION_SERVICE_UNAVAILABLE, purchase: null },
                { status: 500 },
              );
            }
          } catch (error) {
            console.error('IAP verification error:', error);
            return Response.json(
              { error: error instanceof Error ? error.message : IAPError.UNKNOWN_ERROR },
              { status: 500 },
            );
          }
        });
      },
    },
  },
});
