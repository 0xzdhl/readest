import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';

/**
 * Phase 6 integration tests for the stripe route tree.
 *
 *   Owner-only (auth-gated, RLS-scoped via runProtected):
 *     - /api/stripe/check
 *     - /api/stripe/checkout
 *     - /api/stripe/portal
 *     - /api/stripe/plans
 *
 *   Service (no session, RLS bypassed; signature-verified):
 *     - /api/stripe/webhook       — signature failure 400 BEFORE any DB write
 *
 * The Stripe SDK and the webhook signature verifier are mocked because the
 * tests can't reach live Stripe; everything *inside* the route — auth +
 * drizzle queries — runs for real against `readest_app` against the test DB.
 */

const getSessionMock = vi.hoisted(() => vi.fn());
vi.mock('@/auth/server', () => ({
  auth: { api: { getSession: getSessionMock } },
}));

// Stripe SDK mock. Holders are reassigned per-test via the `setStripeMocks`
// helper below; the constructor on `Stripe.default` returns a closure over
// the mutable spies so existing module-level imports still see them.
const stripeSpies = vi.hoisted(() => ({
  constructEvent: vi.fn<(body: string, sig: string, secret: string) => unknown>(),
  subscriptionsRetrieve: vi.fn(),
  checkoutSessionsRetrieve: vi.fn(),
  checkoutSessionsCreate: vi.fn(),
  customersCreate: vi.fn(),
  billingPortalCreate: vi.fn(),
  pricesList: vi.fn(),
}));

vi.mock('stripe', () => {
  class StripeError extends Error {}
  const ctor = vi.fn().mockImplementation(() => ({
    webhooks: { constructEvent: stripeSpies.constructEvent },
    subscriptions: { retrieve: stripeSpies.subscriptionsRetrieve },
    checkout: { sessions: {
      retrieve: stripeSpies.checkoutSessionsRetrieve,
      create: stripeSpies.checkoutSessionsCreate,
    } },
    customers: { create: stripeSpies.customersCreate },
    billingPortal: { sessions: { create: stripeSpies.billingPortalCreate } },
    prices: { list: stripeSpies.pricesList },
  }));
  // Make `Stripe.createFetchHttpClient()` callable on the constructor itself
  // (it's accessed as a static in `getStripe()`).
  (ctor as unknown as { createFetchHttpClient: () => unknown }).createFetchHttpClient = () => ({});
  (ctor as unknown as { errors: { StripeError: typeof StripeError } }).errors = { StripeError };
  return { default: ctor };
});

const url = process.env['TEST_DATABASE_URL'];

let adminClient: ReturnType<typeof postgres>;
let appClient: ReturnType<typeof postgres>;
let appDb: ReturnType<typeof drizzle>;

type CheckRoute = typeof import('@/app/api/stripe/check/route');
type CheckoutRoute = typeof import('@/app/api/stripe/checkout/route');
type PortalRoute = typeof import('@/app/api/stripe/portal/route');
type PlansRoute = typeof import('@/app/api/stripe/plans/route');
type WebhookRoute = typeof import('@/app/api/stripe/webhook/route');

let checkModule: CheckRoute;
let checkoutModule: CheckoutRoute;
let portalModule: PortalRoute;
let plansModule: PlansRoute;
let webhookModule: WebhookRoute;

interface RouteShape {
  options: {
    server: {
      handlers: {
        GET?: (args: { request: Request }) => Promise<Response>;
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

describe.skipIf(!url)('/api/stripe/* (drizzle + runProtected/runService)', () => {
  beforeAll(async () => {
    process.env['STRIPE_SECRET_KEY'] = 'sk_test_unused';
    process.env['STRIPE_SECRET_KEY_DEV'] = 'sk_test_unused';
    process.env['STRIPE_WEBHOOK_SECRET'] = 'whsec_unused';

    adminClient = postgres(url!, { max: 1 });
    const adminDb = drizzle(adminClient);
    await migrate(adminDb, { migrationsFolder: './src/db/migrations' });

    const appUrl = url!.replace(/postgres:\/\/[^@]+@/, 'postgres://readest_app:readest_app@');
    if (appUrl === url) throw new Error('stripe.test: bad TEST_DATABASE_URL');
    appClient = postgres(appUrl, { max: 5, prepare: false });
    appDb = drizzle(appClient);

    const role = await appClient`SELECT current_user`;
    const currentUser = (role[0] as { current_user?: string } | undefined)?.current_user;
    if (currentUser !== 'readest_app') {
      throw new Error(`stripe.test: connected as ${currentUser}, expected readest_app`);
    }

    vi.doMock('@/db/client', () => ({ db: appDb, type: undefined }));

    checkModule = await import('@/app/api/stripe/check/route');
    checkoutModule = await import('@/app/api/stripe/checkout/route');
    portalModule = await import('@/app/api/stripe/portal/route');
    plansModule = await import('@/app/api/stripe/plans/route');
    webhookModule = await import('@/app/api/stripe/webhook/route');

    await adminClient`INSERT INTO "user" (id, email, email_verified, name)
                      VALUES (${userA}, 'a-stripe@test', true, 'User A'),
                             (${userB}, 'b-stripe@test', true, 'User B')
                      ON CONFLICT (id) DO NOTHING`;
  }, 30_000);

  afterAll(async () => {
    await appClient?.end();
    await adminClient?.end();
  });

  beforeEach(async () => {
    getSessionMock.mockReset();
    stripeSpies.constructEvent.mockReset();
    stripeSpies.subscriptionsRetrieve.mockReset();
    stripeSpies.checkoutSessionsRetrieve.mockReset();
    stripeSpies.checkoutSessionsCreate.mockReset();
    stripeSpies.customersCreate.mockReset();
    stripeSpies.billingPortalCreate.mockReset();
    stripeSpies.pricesList.mockReset();
    await adminClient`DELETE FROM payments WHERE user_id IN (${userA}, ${userB})`;
    await adminClient`DELETE FROM subscriptions WHERE user_id IN (${userA}, ${userB})`;
    await adminClient`DELETE FROM customers WHERE user_id IN (${userA}, ${userB})`;
  });

  // ─── plans (owner-only, no DB writes) ──────────────────────────────────
  it('plans: 401 when no session', async () => {
    getSessionMock.mockResolvedValueOnce(null);
    const get = (plansModule.Route as unknown as RouteShape).options.server.handlers.GET!;
    const request = new Request('http://localhost/api/stripe/plans', { method: 'GET' });
    const response = await get({ request });
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toBe('Not authenticated');
  });

  it('plans: returns mapped Stripe price catalogue', async () => {
    getSessionMock.mockResolvedValueOnce(sessionFor(userA));
    stripeSpies.pricesList.mockResolvedValueOnce({
      data: [
        {
          id: 'price_123',
          unit_amount: 999,
          currency: 'usd',
          recurring: { interval: 'month' },
          product: {
            active: true,
            id: 'prod_123',
            name: 'Pro',
            metadata: { plan: 'pro' },
          },
        },
      ],
    });
    const get = (plansModule.Route as unknown as RouteShape).options.server.handlers.GET!;
    const request = new Request('http://localhost/api/stripe/plans', { method: 'GET' });
    const response = await get({ request });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Array<{ plan: string; productId: string }>;
    expect(body[0]?.plan).toBe('pro');
    expect(body[0]?.productId).toBe('price_123');
  });

  // ─── portal (owner-only) ────────────────────────────────────────────────
  it('portal: 401 when no session', async () => {
    getSessionMock.mockResolvedValueOnce(null);
    const post = (portalModule.Route as unknown as RouteShape).options.server.handlers.POST!;
    const request = new Request('http://localhost/api/stripe/portal', { method: 'POST' });
    const response = await post({ request });
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toBe('Not authenticated');
  });

  it('portal: 500 when caller has no customer row', async () => {
    getSessionMock.mockResolvedValueOnce(sessionFor(userA));
    const post = (portalModule.Route as unknown as RouteShape).options.server.handlers.POST!;
    const request = new Request('http://localhost/api/stripe/portal', { method: 'POST' });
    const response = await post({ request });
    expect(response.status).toBe(500);
  });

  it('portal: returns billingPortal URL when customer exists', async () => {
    await adminClient`INSERT INTO customers (user_id, stripe_customer_id)
                      VALUES (${userA}, 'cus_aaa')`;
    stripeSpies.billingPortalCreate.mockResolvedValueOnce({ url: 'https://billing.test/aaa' });
    getSessionMock.mockResolvedValueOnce(sessionFor(userA));
    const post = (portalModule.Route as unknown as RouteShape).options.server.handlers.POST!;
    const request = new Request('http://localhost/api/stripe/portal', { method: 'POST' });
    const response = await post({ request });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { url: string };
    expect(body.url).toBe('https://billing.test/aaa');
  });

  // ─── checkout (owner-only) ──────────────────────────────────────────────
  it('checkout: 401 when no session', async () => {
    getSessionMock.mockResolvedValueOnce(null);
    const post = (checkoutModule.Route as unknown as RouteShape).options.server.handlers.POST!;
    const request = new Request('http://localhost/api/stripe/checkout', {
      method: 'POST',
      body: JSON.stringify({ priceId: 'price_1', planType: 'subscription', embedded: true }),
    });
    const response = await post({ request });
    expect(response.status).toBe(401);
  });

  it('checkout: 400 on invalid body', async () => {
    const post = (checkoutModule.Route as unknown as RouteShape).options.server.handlers.POST!;
    const request = new Request('http://localhost/api/stripe/checkout', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    const response = await post({ request });
    expect(response.status).toBe(400);
  });

  it('checkout: creates customer + session on first call, persists customer row', async () => {
    stripeSpies.customersCreate.mockResolvedValueOnce({ id: 'cus_new' });
    stripeSpies.checkoutSessionsCreate.mockResolvedValueOnce({
      id: 'cs_1',
      url: 'https://checkout.test/cs_1',
      client_secret: 'cs_secret',
    });
    getSessionMock.mockResolvedValueOnce(sessionFor(userA));
    const post = (checkoutModule.Route as unknown as RouteShape).options.server.handlers.POST!;
    const request = new Request('http://localhost/api/stripe/checkout', {
      method: 'POST',
      body: JSON.stringify({ priceId: 'price_1', planType: 'subscription', embedded: true }),
    });
    const response = await post({ request });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { sessionId: string };
    expect(body.sessionId).toBe('cs_1');

    const rows = await adminClient<{ stripe_customer_id: string }[]>`
      SELECT stripe_customer_id FROM customers WHERE user_id = ${userA}`;
    expect(rows[0]?.stripe_customer_id).toBe('cus_new');
  });

  // ─── check (owner-only) ─────────────────────────────────────────────────
  it('check: 401 when no session', async () => {
    getSessionMock.mockResolvedValueOnce(null);
    const post = (checkModule.Route as unknown as RouteShape).options.server.handlers.POST!;
    const request = new Request('http://localhost/api/stripe/check', {
      method: 'POST',
      body: JSON.stringify({ sessionId: 'cs_x' }),
    });
    const response = await post({ request });
    expect(response.status).toBe(401);
  });

  it('check: 400 on missing sessionId', async () => {
    const post = (checkModule.Route as unknown as RouteShape).options.server.handlers.POST!;
    const request = new Request('http://localhost/api/stripe/check', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    const response = await post({ request });
    expect(response.status).toBe(400);
  });

  it('check: returns session for unpaid checkout (no DB write)', async () => {
    stripeSpies.checkoutSessionsRetrieve.mockResolvedValueOnce({
      id: 'cs_unpaid',
      customer: 'cus_aaa',
      payment_status: 'unpaid',
      subscription: null,
      payment_intent: null,
    });
    getSessionMock.mockResolvedValueOnce(sessionFor(userA));
    const post = (checkModule.Route as unknown as RouteShape).options.server.handlers.POST!;
    const request = new Request('http://localhost/api/stripe/check', {
      method: 'POST',
      body: JSON.stringify({ sessionId: 'cs_unpaid' }),
    });
    const response = await post({ request });
    expect(response.status).toBe(200);

    const subs = await adminClient<{ c: string }[]>`
      SELECT count(*)::text AS c FROM subscriptions WHERE user_id = ${userA}`;
    expect(Number(subs[0]?.c)).toBe(0);
  });

  // ─── webhook (runService; signature-verified) ──────────────────────────
  it('webhook: 401 when stripe-signature header missing', async () => {
    const post = (webhookModule.Route as unknown as RouteShape).options.server.handlers.POST!;
    const request = new Request('http://localhost/api/stripe/webhook', {
      method: 'POST',
      body: '{}',
    });
    const response = await post({ request });
    expect(response.status).toBe(401);
  });

  it('webhook: 400 on signature failure, no DB write', async () => {
    stripeSpies.constructEvent.mockImplementationOnce(() => {
      throw new Error('Invalid signature');
    });
    const post = (webhookModule.Route as unknown as RouteShape).options.server.handlers.POST!;
    const request = new Request('http://localhost/api/stripe/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': 'bad' },
      body: JSON.stringify({
        type: 'checkout.session.completed',
        data: { object: { metadata: { userId: userA }, mode: 'payment', id: 'cs_evil' } },
      }),
    });
    const response = await post({ request });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toContain('Webhook signature verification failed');

    // Critical: signature failed BEFORE any DB write happened.
    const subs = await adminClient<{ c: string }[]>`
      SELECT count(*)::text AS c FROM subscriptions WHERE user_id = ${userA}`;
    expect(Number(subs[0]?.c)).toBe(0);
    const pays = await adminClient<{ c: string }[]>`
      SELECT count(*)::text AS c FROM payments WHERE user_id = ${userA}`;
    expect(Number(pays[0]?.c)).toBe(0);
  });

  it('webhook: customer.subscription.deleted persists cancellation + demotes user plan', async () => {
    await adminClient`INSERT INTO subscriptions
        (user_id, stripe_customer_id, stripe_subscription_id, status)
        VALUES (${userA}, 'cus_aaa', 'sub_cancel', 'active')`;
    await adminClient`UPDATE "user" SET plan = 'pro' WHERE id = ${userA}`;

    stripeSpies.constructEvent.mockReturnValueOnce({
      type: 'customer.subscription.deleted',
      data: { object: { id: 'sub_cancel' } },
    });
    const post = (webhookModule.Route as unknown as RouteShape).options.server.handlers.POST!;
    const request = new Request('http://localhost/api/stripe/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': 'good' },
      body: '{}',
    });
    const response = await post({ request });
    expect(response.status).toBe(200);

    const subRow = await adminClient<{ status: string; cancelled_at: Date | null }[]>`
      SELECT status, cancelled_at FROM subscriptions WHERE stripe_subscription_id = 'sub_cancel'`;
    expect(subRow[0]?.status).toBe('cancelled');
    expect(subRow[0]?.cancelled_at).not.toBeNull();

    const userRow = await adminClient<{ plan: string }[]>`
      SELECT plan FROM "user" WHERE id = ${userA}`;
    expect(userRow[0]?.plan).toBe('free');
  });
});
