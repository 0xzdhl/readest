import { describe, expect, it, vi } from 'vitest';

// Stub the middleware so this test only verifies lazy verifier loading,
// not the full middleware chain (auth/db/etc.) — keeps the import cheap so
// the test doesn't time out under parallel suite load.
vi.mock('@/middlewares/rls', () => ({
  rlsMiddleware: { options: { server: () => {} } },
}));

vi.mock('@/libs/payment/iap/google/server', () => ({
  processPurchaseData: vi.fn(),
}));

vi.mock('@/libs/payment/iap/google/verifier', () => {
  throw new Error('google verifier loaded eagerly');
});

describe('/api/google/iap-verify module loading', () => {
  it('does not load the Google verifier until the handler runs', async () => {
    await expect(import('@/app/api/google/iap-verify/route')).resolves.toHaveProperty('Route');
  });
});
