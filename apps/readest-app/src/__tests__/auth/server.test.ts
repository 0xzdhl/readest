import { describe, expectTypeOf, it } from 'vitest';
import type { Session } from '@/auth/server';

/**
 * Pins the shape of `additionalFields` on `session.user`.
 *
 * better-auth's drizzle adapter resolves the `additionalFields` keys
 * against the Drizzle schema's JS property names. The schema declares
 * these as camelCase (`storageUsageBytes`, `storagePurchasedBytes`),
 * so the additionalFields keys must match — otherwise sign-up throws
 * `BetterAuthError: The field "<snake_case>" does not exist in the
 * "user" Drizzle schema.`
 *
 * This test fails at type-check time if the keys regress to snake_case
 * or get dropped.
 */
describe('auth server type shape', () => {
  it('exposes additionalFields on session.user', () => {
    type User = NonNullable<Session>['user'];
    expectTypeOf<User>().toHaveProperty('plan');
    expectTypeOf<User>().toHaveProperty('storageUsageBytes');
    expectTypeOf<User>().toHaveProperty('storagePurchasedBytes');
  });
});
