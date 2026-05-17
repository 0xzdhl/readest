import posthog from 'posthog-js';
import type Stripe from 'stripe';
import { loadStripe, type Stripe as StripeClient } from '@stripe/stripe-js';
import { getAPIBaseUrl, isTauriAppPlatform, isWebAppPlatform } from '@/services/environment';
import { openUrl } from '@tauri-apps/plugin-opener';
import { getAccessToken } from '@/utils/access';
import type { StripeProductMetadata } from '@/types/payment';
import type { AvailablePlan, PlanType } from '@/types/quota';
import { readPublicEnv } from '@/utils/publicEnv';

let stripePromise: Promise<StripeClient | null>;

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
      process.env.NODE_ENV === 'production'
        ? tryDecodeBase64(readPublicEnv('VITE_STRIPE_PUBLISHABLE_KEY_BASE64'))
        : tryDecodeBase64(readPublicEnv('VITE_STRIPE_PUBLISHABLE_KEY_DEV_BASE64'));

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
  return data && Array.isArray(data) ? data : [];
};

export const createStripeCheckoutSession = async (
  productId: string,
  planType: PlanType = 'subscription',
): Promise<StripeCheckoutResponse> => {
  const token = await getAccessToken();
  const isEmbeddedCheckout = isTauriAppPlatform();

  const response = await fetch(WEB_STRIPE_CHECKOUT_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ priceId: productId, planType, embedded: isEmbeddedCheckout }),
  });

  if (!response.ok) {
    throw new Error('Failed to create Stripe checkout session');
  }

  return response.json();
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
  const token = await getAccessToken();

  const response = await fetch(WEB_STRIPE_PORTAL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
  });

  const data = await response.json();

  if (data.error) {
    throw new Error(data.error);
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
