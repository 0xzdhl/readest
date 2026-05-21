import { z } from 'zod';
import { createFileRoute } from '@tanstack/react-router';
import { runProtected } from '@/libs/server/route-helpers';
import type { VerifyPurchaseParams } from '@/libs/payment/iap/google/verifier';
import { processPurchaseData, type VerifiedPurchase } from '@/libs/payment/iap/google/server';
import { IAPError } from '@/libs/payment/iap/types';

const iapVerificationSchema = z.object({
  packageName: z.string().min(1, 'Package name is required'),
  productId: z.string().min(1, 'Product ID is required'),
  orderId: z.string().min(1, 'Order ID is required'),
  purchaseToken: z.string().min(1, 'Purchase token is required'),
});

/**
 * Phase 6: owner-only. Same shape as the Apple sibling — parse first, then
 * `runProtected` for the DB write so the 401 wire-format reshape happens
 * exactly once in route-helpers.
 */
export const Route = createFileRoute('/api/google/iap-verify')({
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
        const { orderId, purchaseToken, productId, packageName } = validatedInput;

        return runProtected(request, async ({ user, tx }) => {
          try {
            const { getGoogleIAPVerifier } = await import('@/libs/payment/iap/google/verifier');
            const googleIAPVerifier = getGoogleIAPVerifier();
            const verifyParams: VerifyPurchaseParams = {
              orderId,
              purchaseToken,
              productId,
              packageName,
            };
            const verificationResult = await googleIAPVerifier.verifyPurchase(verifyParams);
            if (!verificationResult.success) {
              console.error('Google verification failed:', verificationResult.error);
              return Response.json(
                {
                  error: verificationResult.error || IAPError.TRANSACTION_CANNOT_BE_VERIFIED,
                  purchase: null,
                },
                { status: 400 },
              );
            }

            const purchaseData = verificationResult.purchaseData!;
            console.log('Google verification successful:', {
              orderId: purchaseData.orderId,
              productId: productId,
              purchaseState: purchaseData.purchaseState,
            });

            let purchase: VerifiedPurchase;
            try {
              purchase = await processPurchaseData(
                tx,
                { id: user.id, email: user.email },
                verifyParams,
                verificationResult,
              );
              if (verificationResult.purchaseData?.acknowledgementState === 0) {
                try {
                  await googleIAPVerifier.acknowledgePurchase(verifyParams);
                  purchase.acknowledgementState = 1;
                } catch (ackError) {
                  console.error('Failed to acknowledge purchase:', ackError);
                }
              }
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
