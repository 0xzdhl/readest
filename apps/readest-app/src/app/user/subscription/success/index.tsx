import clsx from 'clsx';
import { createFileRoute, useRouter } from '@tanstack/react-router';
import { Suspense, useEffect, useState } from 'react';
import { MdCheck, MdClose, MdScheduleSend } from 'react-icons/md';
import type Stripe from 'stripe';
import { z } from 'zod';
import Spinner from '@/components/Spinner';
import { BoxedList, SettingsRow } from '@/components/settings/primitives';
import { useAuth } from '@/context/AuthContext';
import { useTranslation } from '@/hooks/useTranslation';
import type { VerifiedIAP } from '@/libs/payment/iap/types';
import { getAPIBaseUrl, getNodeAPIBaseUrl, getSupportEmail } from '@/services/environment';
import type { PlanType } from '@/types/quota';
import { fetchWithAuth } from '@/utils/fetch';

const STRIPE_CHECK_URL = `${getAPIBaseUrl()}/stripe/check`;
const APPLE_IAP_VERIFY_URL = `${getNodeAPIBaseUrl()}/apple/iap-verify`;
const ANDROID_IAP_VERIFY_URL = `${getNodeAPIBaseUrl()}/google/iap-verify`;
const subscriptionSuccessSearchSchema = z.object({
  payment: z.string().default('').catch(''),
  platform: z.string().default('').catch(''),
  session_id: z.string().default('').catch(''),
  transaction_id: z.string().default('').catch(''),
  original_transaction_id: z.string().default('').catch(''),
  package_name: z.string().default('').catch(''),
  product_id: z.string().default('').catch(''),
  purchase_token: z.string().default('').catch(''),
  order_id: z.string().default('').catch(''),
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isPlanType = (value: unknown): value is PlanType =>
  value === 'subscription' || value === 'purchase';

const isVerifiedIAP = (value: unknown): value is VerifiedIAP => {
  if (!isRecord(value)) return false;
  return (
    (value['platform'] === 'ios' || value['platform'] === 'android') &&
    typeof value['status'] === 'string' &&
    typeof value['customerEmail'] === 'string' &&
    typeof value['orderId'] === 'string' &&
    typeof value['planName'] === 'string' &&
    isPlanType(value['planType']) &&
    typeof value['productId'] === 'string' &&
    (value['amount'] === undefined || typeof value['amount'] === 'number') &&
    (value['currency'] === undefined || typeof value['currency'] === 'string')
  );
};

const isStripeCheckoutSession = (value: unknown): value is Stripe.Checkout.Session => {
  if (!isRecord(value)) return false;
  return (
    typeof value['id'] === 'string' &&
    (value['payment_status'] === 'paid' ||
      value['payment_status'] === 'unpaid' ||
      value['payment_status'] === 'no_payment_required') &&
    (value['mode'] === 'payment' ||
      value['mode'] === 'subscription' ||
      value['mode'] === 'setup' ||
      value['mode'] === null)
  );
};

const getResponseError = (value: unknown) => {
  if (isRecord(value) && typeof value['error'] === 'string') {
    return value['error'];
  }
  return null;
};

type StripeCheckResponse =
  | { error: string; session?: never }
  | { error?: never; session: Stripe.Checkout.Session };

const parseStripeCheckResponse = (value: unknown): StripeCheckResponse => {
  const error = getResponseError(value);
  if (error) {
    return { error };
  }
  if (isRecord(value) && isStripeCheckoutSession(value['session'])) {
    return { session: value['session'] };
  }
  throw new Error('Invalid Stripe session response');
};

type IAPVerifyResponse =
  | { error: string; purchase?: never }
  | { error?: never; purchase: VerifiedIAP };

const parseIAPVerifyResponse = (value: unknown): IAPVerifyResponse => {
  const error = getResponseError(value);
  if (error) {
    return { error };
  }
  if (isRecord(value) && isVerifiedIAP(value['purchase'])) {
    return { purchase: value['purchase'] };
  }
  throw new Error('Invalid IAP verification response');
};

export const Route = createFileRoute('/user/subscription/success/')({
  validateSearch: subscriptionSuccessSearchSchema,
  component: SubscriptionSuccessPage,
});

interface SessionStatus {
  status: 'loading' | 'completed' | 'failed' | 'processing';
  customerEmail: string;
  orderId?: string;
  planName?: string;
  planType: PlanType;
  amount?: number; // in cents
  currency?: string;
}

const SubscriptionSuccessContent = () => {
  const _ = useTranslation();
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>({
    status: 'loading',
    planType: 'subscription',
    customerEmail: '',
  });
  const [retryCount, setRetryCount] = useState(0);
  const search = Route.useSearch();
  const router = useRouter();
  const { refresh } = useAuth();
  const payment = search.payment || undefined;
  const platform = search.platform || undefined;
  const sessionId = search.session_id || undefined;

  // iOS parameters
  const transactionId = search.transaction_id || undefined;
  const originalTransactionId = search.original_transaction_id || undefined;

  // Android parameters
  const packageName = search.package_name || undefined;
  const productId = search.product_id || undefined;
  const purchaseToken = search.purchase_token || undefined;
  const orderId = search.order_id || undefined;

  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const updateStripeSessionStatus = async () => {
    try {
      const response = await fetchWithAuth(STRIPE_CHECK_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ sessionId }),
      });

      const stripeCheck = parseStripeCheckResponse(await response.json());

      if ('error' in stripeCheck) {
        setSessionStatus((prev) => ({ ...prev, status: 'failed' }));
        console.error('Session check error:', stripeCheck.error);
        return;
      }

      const { session } = stripeCheck;
      setSessionStatus({
        status: session.payment_status === 'paid' ? 'completed' : 'failed',
        customerEmail: session.customer_email || session.customer_details?.email || '',
        orderId: (session.subscription || session.payment_intent || '') as string,
        planName: session.line_items?.data?.[0]?.description || '',
        planType: session.mode === 'payment' ? 'purchase' : 'subscription',
        amount: session.amount_total || undefined,
        currency: session.currency || undefined,
      });

      refresh();
    } catch (error) {
      console.error('Failed to fetch session status:', error);
      setSessionStatus((prev) => ({ ...prev, status: 'failed' }));
    }
  };

  const updateIOSIAPSessionStatus = async (
    transactionId: string,
    originalTransactionId: string,
  ) => {
    if (!transactionId || !originalTransactionId) {
      setSessionStatus((prev) => ({ ...prev, status: 'failed' }));
      return;
    }
    try {
      const response = await fetchWithAuth(APPLE_IAP_VERIFY_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          transactionId,
          originalTransactionId,
        }),
      });

      const iapVerification = parseIAPVerifyResponse(await response.json());

      if ('error' in iapVerification) {
        setSessionStatus((prev) => ({ ...prev, status: 'failed' }));
        console.error('IAP verification error:', iapVerification.error);
        return;
      }

      const { purchase } = iapVerification;
      setSessionStatus({
        status: purchase.status === 'active' ? 'completed' : 'failed',
        customerEmail: purchase.customerEmail || '',
        orderId: purchase.orderId,
        planName: purchase.planName,
        planType: purchase.planType,
      });

      refresh();
    } catch (error) {
      console.error('Failed to verify IAP transaction:', error);
      setSessionStatus((prev) => ({ ...prev, status: 'failed' }));
    }
  };

  const updateAndroidIAPSessionStatus = async (
    packageName: string,
    productId: string,
    orderId: string,
    purchaseToken: string,
  ) => {
    if (!purchaseToken || !productId || !packageName) {
      console.error('Missing required Android IAP parameters');
      setSessionStatus((prev) => ({ ...prev, status: 'failed' }));
      return;
    }

    try {
      const response = await fetchWithAuth(ANDROID_IAP_VERIFY_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          purchaseToken,
          orderId,
          productId,
          packageName,
        }),
      });

      const iapVerification = parseIAPVerifyResponse(await response.json());

      if ('error' in iapVerification) {
        setSessionStatus((prev) => ({ ...prev, status: 'failed' }));
        console.error('Android IAP verification error:', iapVerification.error);
        return;
      }

      const { purchase } = iapVerification;
      setSessionStatus({
        status: purchase.status === 'active' ? 'completed' : 'failed',
        customerEmail: purchase.customerEmail || '',
        orderId: purchase.orderId,
        planName: purchase.planName,
        planType: purchase.planType,
        amount: purchase.amount,
        currency: purchase.currency,
      });

      refresh();
    } catch (error) {
      console.error('Failed to verify Android IAP transaction:', error);
      setSessionStatus((prev) => ({ ...prev, status: 'failed' }));
    }
  };

  const updateIAPSessionStatus = async () => {
    if (platform === 'ios' && transactionId && originalTransactionId) {
      await updateIOSIAPSessionStatus(transactionId, originalTransactionId);
    } else if (platform === 'android' && orderId && purchaseToken && productId && packageName) {
      await updateAndroidIAPSessionStatus(packageName, productId, orderId, purchaseToken);
    } else {
      console.error('Invalid IAP platform or missing parameters');
      setSessionStatus((prev) => ({ ...prev, status: 'failed' }));
    }
  };

  const updateSessionStatus = async () => {
    if (payment === 'stripe' && sessionId) {
      await updateStripeSessionStatus();
    } else if (payment === 'iap') {
      await updateIAPSessionStatus();
    } else {
      setSessionStatus((prev) => ({ ...prev, status: 'failed' }));
    }
  };

  const handleRetry = () => {
    setRetryCount(0);
    setSessionStatus((prev) => ({ ...prev, status: 'loading' }));
    updateSessionStatus();
  };

  const handleGoToLibrary = () => {
    router.navigate({ to: '/library', search: { group: '', groupBy: '', opds: '' } });
  };

  const handleGoToProfile = () => {
    router.navigate({ to: '/user', search: { section: '' } });
  };

  useEffect(() => {
    updateSessionStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, originalTransactionId, router]);

  useEffect(() => {
    if (sessionStatus.status === 'processing' && retryCount < 3) {
      const timer = setTimeout(() => {
        setRetryCount((prev) => prev + 1);
        updateSessionStatus();
      }, 2000);

      return () => clearTimeout(timer);
    } else {
      return;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionStatus.status, retryCount]);

  if (!mounted) {
    return null;
  }

  const formattedAmount =
    sessionStatus.amount && sessionStatus.currency
      ? new Intl.NumberFormat('en-US', {
          style: 'currency',
          currency: sessionStatus.currency.toUpperCase(),
        }).format(sessionStatus.amount / 100)
      : undefined;

  // Loading state
  if (sessionStatus.status === 'loading') {
    return (
      <StatusPage>
        <StatusIcon>
          <div
            className='border-base-content/25 border-t-base-content h-7 w-7 animate-spin rounded-full border-2 motion-reduce:animate-none'
            aria-hidden='true'
          />
        </StatusIcon>
        <StatusHeading>{_('Processing your payment...')}</StatusHeading>
        <StatusSupport>{_('Please wait while we confirm your subscription.')}</StatusSupport>
      </StatusPage>
    );
  }

  // Processing state (payment still being processed)
  if (sessionStatus.status === 'processing') {
    return (
      <StatusPage>
        <StatusIcon>
          <MdScheduleSend className='text-base-content h-7 w-7' aria-hidden='true' />
        </StatusIcon>
        <StatusHeading>{_('Payment Processing')}</StatusHeading>
        <StatusSupport>
          {_('Your payment is being processed. This usually takes a few moments.')}
        </StatusSupport>
      </StatusPage>
    );
  }

  // Failed state
  if (sessionStatus.status === 'failed') {
    return (
      <StatusPage>
        <StatusIcon tone='error'>
          <MdClose className='text-error h-7 w-7' aria-hidden='true' />
        </StatusIcon>
        <StatusHeading>{_('Payment Failed')}</StatusHeading>
        <StatusSupport>
          {_(
            "We couldn't process your subscription. Please try again or contact support if the issue persists.",
          )}
        </StatusSupport>
        <div className='mt-8 flex w-full flex-col gap-3 sm:flex-row sm:justify-center'>
          <button onClick={handleRetry} className='btn btn-primary w-full sm:w-auto sm:min-w-44'>
            {_('Try Again')}
          </button>
          <button
            onClick={handleGoToProfile}
            className='btn btn-ghost w-full sm:w-auto sm:min-w-44'
          >
            {_('Back to Profile')}
          </button>
        </div>
        <SupportNote _={_} />
      </StatusPage>
    );
  }

  // Success state
  const successHeading =
    sessionStatus.planType === 'purchase' ? _('Purchase Successful') : _('Subscription Successful');
  const successSupport =
    sessionStatus.planType === 'purchase'
      ? _('Thank you for your purchase. Your payment has been processed successfully.')
      : _('Thank you for your subscription. Your payment has been processed successfully.');

  const hasDetails = Boolean(
    sessionStatus.customerEmail ||
    sessionStatus.planName ||
    formattedAmount ||
    sessionStatus.orderId,
  );

  return (
    <StatusPage>
      <StatusIcon tone='success'>
        <MdCheck className='text-success h-8 w-8' aria-hidden='true' />
      </StatusIcon>
      <StatusHeading>{successHeading}</StatusHeading>
      <StatusSupport>{successSupport}</StatusSupport>

      {hasDetails && (
        <BoxedList title={_('Order Details')} className='mt-8 text-start'>
          {sessionStatus.customerEmail && (
            <SettingsRow label={_('Email')}>
              <span className='text-base-content/80 min-w-0 truncate text-end'>
                {sessionStatus.customerEmail}
              </span>
            </SettingsRow>
          )}
          {sessionStatus.planName && (
            <SettingsRow label={_('Plan')}>
              <span className='text-base-content/80 min-w-0 truncate text-end'>
                {_(sessionStatus.planName)}
              </span>
            </SettingsRow>
          )}
          {formattedAmount && (
            <SettingsRow label={_('Amount')}>
              <span className='text-base-content/80 text-end'>{formattedAmount}</span>
            </SettingsRow>
          )}
          {sessionStatus.orderId && (
            <SettingsRow label={_('Order ID')}>
              <span className='text-base-content/70 min-w-0 truncate text-end font-mono text-[0.85em]'>
                {sessionStatus.orderId}
              </span>
            </SettingsRow>
          )}
        </BoxedList>
      )}

      <div className='mt-8 flex w-full flex-col gap-3 sm:flex-row sm:justify-center'>
        <button
          onClick={handleGoToLibrary}
          className='btn btn-primary w-full sm:w-auto sm:min-w-44'
        >
          {_('Go to Library')}
        </button>
        <button onClick={handleGoToProfile} className='btn btn-ghost w-full sm:w-auto sm:min-w-44'>
          {_('Back to Profile')}
        </button>
      </div>

      <SupportNote _={_} />
    </StatusPage>
  );
};

/**
 * Spacious, full-height status scaffold. The content sits in an airy,
 * vertically-centered column (not a floating card-island) over the window
 * backdrop, with generous rhythm between the status icon, headline, details,
 * and actions.
 */
const StatusPage: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className='bg-base-200 flex min-h-[100dvh] items-center justify-center'>
    <div className='flex w-full max-w-xl flex-col items-center px-6 py-16 text-center'>
      {children}
    </div>
  </div>
);

/**
 * Status icon chip. Reads in e-ink via a 1px contrast border (eink-bordered)
 * plus a tonal two-step fill that still parses with no color.
 */
const StatusIcon: React.FC<{
  children: React.ReactNode;
  tone?: 'neutral' | 'success' | 'error';
}> = ({ children, tone = 'neutral' }) => (
  <div
    className={clsx(
      'eink-bordered mb-6 flex h-16 w-16 items-center justify-center rounded-full border',
      tone === 'success' && 'border-success/30 bg-success/10',
      tone === 'error' && 'border-error/30 bg-error/10',
      tone === 'neutral' && 'border-base-300 bg-base-100',
    )}
  >
    {children}
  </div>
);

const StatusHeading: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <h1 className='text-base-content text-2xl font-bold tracking-tight sm:text-3xl'>{children}</h1>
);

const StatusSupport: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <p className='text-base-content/70 mt-3 max-w-md leading-relaxed'>{children}</p>
);

const SupportNote: React.FC<{ _: ReturnType<typeof useTranslation> }> = ({ _ }) => (
  <p className='text-base-content/60 mt-10 text-[0.85em]'>
    {_('Need help? Contact our support team at {{email}}', { email: getSupportEmail() })}
  </p>
);

function SubscriptionSuccessPage() {
  return (
    <Suspense
      fallback={
        <div className='fixed inset-0 z-50 flex items-center justify-center'>
          <Spinner loading />
        </div>
      }
    >
      <SubscriptionSuccessContent />
    </Suspense>
  );
}
