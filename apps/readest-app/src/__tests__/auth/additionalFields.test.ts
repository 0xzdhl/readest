import { describe, expect, it } from 'vitest';
import { userAdditionalFields } from '@/auth/server';

/**
 * Privilege-escalation guard.
 *
 * better-auth's built-in `POST /api/auth/update-user` writes any
 * `additionalField` that lacks `input: false` straight to the user row
 * via its `parseUserInput` path. Plan / quota fields are server-owned
 * (set by the Stripe webhook, IAP verification, and storage accounting
 * via direct drizzle updates), so they MUST be marked `input: false` to
 * reject client-supplied values and prevent self-escalation of
 * plan/quota.
 */
describe('auth user additionalFields privilege guard', () => {
  it.each(['plan', 'storageUsageBytes', 'storagePurchasedBytes'] as const)(
    'marks %s as input:false so update-user cannot set it',
    (field) => {
      expect(userAdditionalFields[field].input).toBe(false);
    },
  );
});
