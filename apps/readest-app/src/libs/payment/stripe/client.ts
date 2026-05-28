import { loadStripe, type Stripe as StripeClient } from '@stripe/stripe-js';
import { openUrl } from '@tauri-apps/plugin-opener';
import posthog from 'posthog-js';
import type Stripe from 'stripe';
import { clientEnv } from '@/clientEnv';
import { getAPIBaseUrl, isTauriAppPlatform, isWebAppPlatform } from '@/services/environment';
import type { StripeProductMetadata } from '@/types/payment';
import type { AvailablePlan, PlanInterval, PlanType, UserPlan } from '@/types/quota';
import { fetchWithAuth } from '@/utils/fetch';

let stripePromise: Promise<StripeClient | null>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const USER_PLANS = ['free', 'plus', 'pro', 'purchase'] as const satisfies readonly UserPlan[];
const PLAN_INTERVALS = ['month', 'year', 'lifetime'] as const satisfies readonly PlanInterval[];

const isUserPlan = (value: unknown): value is UserPlan =>
  typeof value === 'string' && USER_PLANS.includes(value as UserPlan);

const isPlanInterval = (value: unknown): value is PlanInterval =>
  typeof value === 'string' && PLAN_INTERVALS.includes(value as PlanInterval);

const isStripeCheckoutResponse = (value: unknown): value is StripeCheckoutResponse => {
  if (!isRecord(value)) return false;
  return (
    (value['sessionId'] === undefined || typeof value['sessionId'] === 'string') &&
    (value['clientSecret'] === undefined || typeof value['clientSecret'] === 'string') &&
    (value['url'] === undefined || typeof value['url'] === 'string')
  );
};

const isStripePortalResponse = (value: unknown): value is { url: string; error?: string } => {
  if (!isRecord(value)) return false;
  return (
    typeof value['url'] === 'string' &&
    (value['error'] === undefined || typeof value['error'] === 'string')
  );
};

const getStripePortalError = (value: unknown) => {
  if (isRecord(value) && typeof value['error'] === 'string') {
    return value['error'];
  }
  return null;
};

const tryDecodeBase64 = (value: string | undefined) => {
  if (!value) return undefined;
  try {
    return atob(value);
  } catch {
    return undefined;
  }
};

export const getStripe = () => {
  if (!stripePromise) {
    const publishableKey =
      clientEnv.NODE_ENV === 'production'
        ? tryDecodeBase64(clientEnv.VITE_STRIPE_PUBLISHABLE_KEY_BASE64)
        : tryDecodeBase64(clientEnv.VITE_STRIPE_PUBLISHABLE_KEY_DEV_BASE64);

    if (!publishableKey) {
      console.warn(
        'Stripe publishable key is missing. Set VITE_STRIPE_PUBLISHABLE_KEY_BASE64 or VITE_STRIPE_PUBLISHABLE_KEY_DEV_BASE64 to enable checkout.',
      );
      stripePromise = Promise.resolve(null);
    } else {
      stripePromise = loadStripe(publishableKey);
    }
  }
  return stripePromise;
};

const WEB_STRIPE_PLANS_URL = `${getAPIBaseUrl()}/stripe/plans`;
const WEB_STRIPE_CHECKOUT_URL = `${getAPIBaseUrl()}/stripe/checkout`;
const WEB_STRIPE_PORTAL_URL = `${getAPIBaseUrl()}/stripe/portal`;
const SUBSCRIPTION_SUCCESS_PATH = '/user/subscription/success';

export interface StripeCheckoutResponse {
  sessionId?: string;
  clientSecret?: string;
  url?: string;
}

export type StripeAvailablePlan = AvailablePlan & {
  metadata?: StripeProductMetadata;
  product?: Stripe.Product;
};

export const fetchStripePlans = async () => {
  const response = await fetch(WEB_STRIPE_PLANS_URL);
  const data = await response.json();
  if (!Array.isArray(data)) {
    return [];
  }
  return data.filter((plan): plan is StripeAvailablePlan => {
    if (!isRecord(plan)) return false;
    return (
      typeof plan['productId'] === 'string' &&
      typeof plan['price'] === 'number' &&
      typeof plan['currency'] === 'string' &&
      typeof plan['productName'] === 'string' &&
      isUserPlan(plan['plan']) &&
      isPlanInterval(plan['interval'])
    );
  });
};

export const createStripeCheckoutSession = async (
  productId: string,
  planType: PlanType = 'subscription',
): Promise<StripeCheckoutResponse> => {
  const isEmbeddedCheckout = isTauriAppPlatform();
  const response = await fetchWithAuth(WEB_STRIPE_CHECKOUT_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ priceId: productId, planType, embedded: isEmbeddedCheckout }),
  });

  const data = await response.json();
  if (!isStripeCheckoutResponse(data)) {
    throw new Error('Invalid Stripe checkout response');
  }
  return data;
};

export const redirectToStripeCheckout = async (url?: string): Promise<void> => {
  if (url) {
    if (isWebAppPlatform()) {
      window.location.href = url;
    } else if (isTauriAppPlatform()) {
      await openUrl(url);
    }
  } else {
    throw new Error('No checkout URL returned from the Stripe API');
  }
};

export const createStripePortalSession = async () => {
  const response = await fetchWithAuth(WEB_STRIPE_PORTAL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
  });

  const data = await response.json();

  const error = getStripePortalError(data);
  if (error) {
    throw new Error(error);
  }

  if (!isStripePortalResponse(data)) {
    throw new Error('Invalid Stripe portal response');
  }

  return data.url;
};

export const redirectToStripePortal = async (url: string): Promise<void> => {
  if (isWebAppPlatform()) {
    window.location.href = url;
  } else if (isTauriAppPlatform()) {
    await openUrl(url);
  }
};

export const handleStripeCheckoutError = (error: string) => {
  console.error(error);
  posthog.capture('checkout_error', { error });
};

export const getSubscriptionSuccessUrl = (sessionId: string) => {
  const params = new URLSearchParams({
    payment: 'stripe',
    session_id: sessionId,
  });
  return `${SUBSCRIPTION_SUCCESS_PATH}?${params.toString()}`;
};
