import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';

/**
 * Phase 6 integration tests for /api/apple/iap-verify and
 * /api/google/iap-verify. Same scaffolding as `stripe.test.ts`: the
 * verifier modules are mocked (they reach for the App Store / Play Store
 * API in production) and the route's drizzle writes go to the real test
 * DB via `readest_app`.
 */

const getSessionMock = vi.hoisted(() => vi.fn());
vi.mock('@/auth/server', () => ({
  auth: { api: { getSession: getSessionMock } },
}));

const appleVerifierSpies = vi.hoisted(() => ({
  verifyTransaction: vi.fn(),
}));
vi.mock('@/libs/payment/iap/apple/verifier', () => ({
  getAppleIAPVerifier: () => ({ verifyTransaction: appleVerifierSpies.verifyTransaction }),
}));

const googleVerifierSpies = vi.hoisted(() => ({
  verifyPurchase: vi.fn(),
  acknowledgePurchase: vi.fn(),
}));
vi.mock('@/libs/payment/iap/google/verifier', () => ({
  getGoogleIAPVerifier: () => ({
    verifyPurchase: googleVerifierSpies.verifyPurchase,
    acknowledgePurchase: googleVerifierSpies.acknowledgePurchase,
  }),
}));

// Stub the product-id helpers so the test doesn't need real product IDs
// to map to a plan. The handlers don't care about plan name correctness —
// they only need to be told whether something is a storage purchase.
vi.mock('@/libs/payment/iap/utils', () => ({
  isStoragePurchase: (productId: string) => productId.includes('storage'),
  parseStorageGB: () => 5,
  mapProductIdToProductName: () => 'Pro',
  mapProductIdToUserPlan: () => 'pro',
}));

const url = process.env['TEST_DATABASE_URL'];

let adminClient: ReturnType<typeof postgres>;
let appClient: ReturnType<typeof postgres>;
let appDb: ReturnType<typeof drizzle>;

type AppleRoute = typeof import('@/app/api/apple/iap-verify/route');
type GoogleRoute = typeof import('@/app/api/google/iap-verify/route');

let appleModule: AppleRoute;
let googleModule: GoogleRoute;

interface RouteShape {
  options: {
    server: {
      handlers: {
        POST?: (args: { request: Request }) => Promise<Response>;
      };
    };
  };
}

const userA = '11111111-1111-1111-1111-111111111111';
const userB = '22222222-2222-2222-2222-222222222222';

const sessionFor = (userId: string) => ({
  user: {
    id: userId,
    email: `${userId}@test`,
    emailVerified: true,
    name: 'Test',
    plan: 'free',
    storageUsageBytes: 0,
    storagePurchasedBytes: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  session: { id: 'sess-' + userId, userId, token: 't', expiresAt: new Date() },
});

describe.skipIf(!url)('/api/{apple,google}/iap-verify (drizzle + runProtected)', () => {
  beforeAll(async () => {
    adminClient = postgres(url!, { max: 1 });
    const adminDb = drizzle(adminClient);
    await migrate(adminDb, { migrationsFolder: './src/db/migrations' });

    const appUrl = url!.replace(/postgres:\/\/[^@]+@/, 'postgres://readest_app:readest_app@');
    if (appUrl === url) throw new Error('iap.test: bad TEST_DATABASE_URL');
    appClient = postgres(appUrl, { max: 5, prepare: false });
    appDb = drizzle(appClient);

    const role = await appClient`SELECT current_user`;
    const currentUser = (role[0] as { current_user?: string } | undefined)?.current_user;
    if (currentUser !== 'readest_app') {
      throw new Error(`iap.test: connected as ${currentUser}, expected readest_app`);
    }

    vi.doMock('@/db/client', () => ({ db: appDb, type: undefined }));

    appleModule = await import('@/app/api/apple/iap-verify/route');
    googleModule = await import('@/app/api/google/iap-verify/route');

    await adminClient`INSERT INTO "user" (id, email, email_verified, name)
                      VALUES (${userA}, 'a-iap@test', true, 'User A'),
                             (${userB}, 'b-iap@test', true, 'User B')
                      ON CONFLICT (id) DO NOTHING`;
  }, 30_000);

  afterAll(async () => {
    await appClient?.end();
    await adminClient?.end();
  });

  beforeEach(async () => {
    getSessionMock.mockReset();
    appleVerifierSpies.verifyTransaction.mockReset();
    googleVerifierSpies.verifyPurchase.mockReset();
    googleVerifierSpies.acknowledgePurchase.mockReset();
    await adminClient`DELETE FROM payments WHERE user_id IN (${userA}, ${userB})`;
    await adminClient`DELETE FROM apple_iap_subscriptions WHERE user_id IN (${userA}, ${userB})`;
    await adminClient`DELETE FROM google_iap_subscriptions WHERE user_id IN (${userA}, ${userB})`;
  });

  // ─── Apple ──────────────────────────────────────────────────────────────
  it('apple: 401 when no session', async () => {
    getSessionMock.mockResolvedValueOnce(null);
    const post = (appleModule.Route as unknown as RouteShape).options.server.handlers.POST!;
    const request = new Request('http://localhost/api/apple/iap-verify', {
      method: 'POST',
      body: JSON.stringify({ transactionId: 't1', originalTransactionId: 'ot1' }),
    });
    const response = await post({ request });
    expect(response.status).toBe(401);
  });

  it('apple: 400 on invalid body', async () => {
    const post = (appleModule.Route as unknown as RouteShape).options.server.handlers.POST!;
    const request = new Request('http://localhost/api/apple/iap-verify', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    const response = await post({ request });
    expect(response.status).toBe(400);
  });

  it('apple: persists a subscription on successful verification', async () => {
    appleVerifierSpies.verifyTransaction.mockResolvedValueOnce({
      success: true,
      status: 'active',
      planType: 'subscription',
      transaction: {
        transactionId: 'apple-tx-1',
        originalTransactionId: 'apple-ot-1',
        productId: 'pro.monthly',
        environment: 'Production',
        bundleId: 'com.test.app',
        quantity: 1,
        webOrderLineItemId: 'wol-1',
        subscriptionGroupIdentifier: 'sg-1',
        type: 'Auto-Renewable Subscription',
      },
      purchaseDate: new Date('2024-01-01'),
      expiresDate: new Date('2024-02-01'),
    });
    getSessionMock.mockResolvedValueOnce(sessionFor(userA));
    const post = (appleModule.Route as unknown as RouteShape).options.server.handlers.POST!;
    const request = new Request('http://localhost/api/apple/iap-verify', {
      method: 'POST',
      body: JSON.stringify({ transactionId: 'apple-tx-1', originalTransactionId: 'apple-ot-1' }),
    });
    const response = await post({ request });
    expect(response.status).toBe(200);

    const subs = await adminClient<{ status: string; product_id: string }[]>`
      SELECT status, product_id FROM apple_iap_subscriptions WHERE user_id = ${userA}`;
    expect(subs).toHaveLength(1);
    expect(subs[0]?.status).toBe('active');
    expect(subs[0]?.product_id).toBe('pro.monthly');

    const userRow = await adminClient<{ plan: string }[]>`
      SELECT plan FROM "user" WHERE id = ${userA}`;
    expect(userRow[0]?.plan).toBe('pro');
  });

  // ─── Google ─────────────────────────────────────────────────────────────
  it('google: 401 when no session', async () => {
    getSessionMock.mockResolvedValueOnce(null);
    const post = (googleModule.Route as unknown as RouteShape).options.server.handlers.POST!;
    const request = new Request('http://localhost/api/google/iap-verify', {
      method: 'POST',
      body: JSON.stringify({
        packageName: 'com.test.app',
        productId: 'pro.monthly',
        orderId: 'order-1',
        purchaseToken: 'token-1',
      }),
    });
    const response = await post({ request });
    expect(response.status).toBe(401);
  });

  it('google: 400 on invalid body', async () => {
    const post = (googleModule.Route as unknown as RouteShape).options.server.handlers.POST!;
    const request = new Request('http://localhost/api/google/iap-verify', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    const response = await post({ request });
    expect(response.status).toBe(400);
  });

  it('google: persists a payment on successful one-time purchase', async () => {
    googleVerifierSpies.verifyPurchase.mockResolvedValueOnce({
      success: true,
      status: 'active',
      purchaseType: 'product',
      purchaseData: {
        orderId: 'g-order-1',
        purchaseState: 0,
        acknowledgementState: 1,
        quantity: 1,
        regionCode: 'US',
        purchaseType: undefined,
        developerPayload: '',
        obfuscatedExternalAccountId: '',
        obfuscatedExternalProfileId: '',
      },
      purchaseDate: new Date('2024-03-01'),
    });
    getSessionMock.mockResolvedValueOnce(sessionFor(userA));
    const post = (googleModule.Route as unknown as RouteShape).options.server.handlers.POST!;
    const request = new Request('http://localhost/api/google/iap-verify', {
      method: 'POST',
      body: JSON.stringify({
        packageName: 'com.test.app',
        productId: 'storage.10gb',
        orderId: 'g-order-1',
        purchaseToken: 'g-token-1',
      }),
    });
    const response = await post({ request });
    expect(response.status).toBe(200);

    const pays = await adminClient<
      { status: string; storage_gb: number; product_id: string }[]
    >`SELECT status, storage_gb, product_id FROM payments WHERE user_id = ${userA}`;
    expect(pays).toHaveLength(1);
    expect(pays[0]?.status).toBe('completed');
    expect(pays[0]?.storage_gb).toBe(5);
    expect(pays[0]?.product_id).toBe('storage.10gb');
  });
});
