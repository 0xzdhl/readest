import { describe, expect, it, vi } from 'vitest';

vi.mock('@/libs/server/route-helpers', () => ({
  runProtected: vi.fn(),
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
