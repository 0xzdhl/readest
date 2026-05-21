import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// `access.ts` no longer pulls anything off a JWT — every helper reads
// directly off the better-auth `session.user` object that the React
// useSession() hook (or `auth.api.getSession` on the server) hands out.
// We mock the env helpers so the tests don't accidentally hit Vite envs,
// and mock the daily-translation usage helper so we can pin translation
// math.

vi.mock('@/services/environment', () => ({
  isWebAppPlatform: () => true,
  isTauriAppPlatform: () => false,
}));

vi.mock('@/utils/publicEnv', () => ({
  readPublicEnv: () => '',
  readPublicFlag: () => false,
}));

vi.mock('@/services/translators/utils', () => ({
  getDailyUsage: vi.fn(() => 0),
}));

vi.mock('@/auth', () => ({
  loadToken: vi.fn(() => null),
  authClient: {
    getSession: vi.fn(async () => ({ data: null })),
  },
}));

import {
  getSubscriptionPlan,
  getUserProfilePlan,
  getStoragePlanData,
  getTranslationPlanData,
  getDailyTranslationPlanData,
  getTranslationQuota,
  STORAGE_QUOTA_GRACE_BYTES,
} from '@/utils/access';
import { getDailyUsage } from '@/services/translators/utils';

type StubUser = {
  id: string;
  email: string;
  plan?: string | null;
  storageUsageBytes?: number | null;
  storagePurchasedBytes?: number | null;
};

const mkUser = (overrides: Partial<StubUser> = {}): StubUser => ({
  id: 'u1',
  email: 'a@b.com',
  plan: 'free',
  storageUsageBytes: 0,
  storagePurchasedBytes: 0,
  ...overrides,
});

describe('access.ts (better-auth)', () => {
  beforeEach(() => {
    vi.mocked(getDailyUsage).mockReturnValue(0);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('STORAGE_QUOTA_GRACE_BYTES', () => {
    it('is 10 MiB', () => {
      expect(STORAGE_QUOTA_GRACE_BYTES).toBe(10 * 1024 * 1024);
    });
  });

  describe('getSubscriptionPlan', () => {
    it('returns the plan on the user', () => {
      expect(getSubscriptionPlan(mkUser({ plan: 'plus' }))).toBe('plus');
    });
    it("defaults to 'free' for missing/null plan", () => {
      expect(getSubscriptionPlan(mkUser({ plan: null }))).toBe('free');
    });
    it("returns 'free' when user is null", () => {
      expect(getSubscriptionPlan(null)).toBe('free');
    });
  });

  describe('getUserProfilePlan', () => {
    it("returns 'purchase' when free user has purchased storage", () => {
      expect(
        getUserProfilePlan(mkUser({ plan: 'free', storagePurchasedBytes: 100 })),
      ).toBe('purchase');
    });
    it("keeps 'free' when no purchase", () => {
      expect(getUserProfilePlan(mkUser({ plan: 'free' }))).toBe('free');
    });
    it('passes through non-free plans untouched', () => {
      expect(getUserProfilePlan(mkUser({ plan: 'pro' }))).toBe('pro');
    });
  });

  describe('getStoragePlanData', () => {
    it('combines plan default + purchased bytes', () => {
      const data = getStoragePlanData(
        mkUser({ plan: 'free', storageUsageBytes: 5, storagePurchasedBytes: 100 }),
      );
      expect(data.plan).toBe('free');
      expect(data.usage).toBe(5);
      // free plan default = 500 MiB, plus 100 purchased
      expect(data.quota).toBe(500 * 1024 * 1024 + 100);
    });
    it('zeros for null user', () => {
      const data = getStoragePlanData(null);
      expect(data.plan).toBe('free');
      expect(data.usage).toBe(0);
      expect(data.quota).toBeGreaterThan(0);
    });
  });

  describe('getTranslationQuota', () => {
    it('returns plan-default quota', () => {
      expect(getTranslationQuota('free')).toBe(10 * 1024);
      expect(getTranslationQuota('plus')).toBe(100 * 1024);
    });
  });

  describe('getTranslationPlanData', () => {
    it('reads daily usage and plan quota', () => {
      vi.mocked(getDailyUsage).mockReturnValueOnce(123);
      const data = getTranslationPlanData(mkUser({ plan: 'plus' }));
      expect(data.plan).toBe('plus');
      expect(data.usage).toBe(123);
      expect(data.quota).toBe(100 * 1024);
    });
    it('defaults usage to 0 when getDailyUsage returns null', () => {
      vi.mocked(getDailyUsage).mockReturnValueOnce(null);
      const data = getTranslationPlanData(mkUser({ plan: 'free' }));
      expect(data.usage).toBe(0);
    });
  });

  describe('getDailyTranslationPlanData', () => {
    it('returns plan + quota only', () => {
      const data = getDailyTranslationPlanData(mkUser({ plan: 'pro' }));
      expect(data).toEqual({ plan: 'pro', quota: 500 * 1024 });
    });
  });
});
