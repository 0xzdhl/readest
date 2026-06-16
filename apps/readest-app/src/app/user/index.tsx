import clsx from 'clsx';
import { useState, useEffect, useCallback } from 'react';
import { createFileRoute, useRouter } from '@tanstack/react-router';
import { z } from 'zod';
import type { IconType } from 'react-icons';
import {
  MdOutlineCloud,
  MdOutlineLink,
  MdOutlinePerson,
  MdOutlineSync,
  MdOutlineWorkspacePremium,
} from 'react-icons/md';
import { usePlatformInfo, useBooted } from '@/context/EffectRuntimeProvider';
import { useAuth } from '@/context/AuthContext';
import { useTheme } from '@/hooks/useTheme';
import { useThemeStore } from '@/store/themeStore';
import { useQuotaStats } from '@/hooks/useQuotaStats';
import { useTranslation } from '@/hooks/useTranslation';
import { useUserActions } from '@/hooks/useUserActions';
import { useAvailablePlans } from '@/hooks/useAvailablePlans';
import type { PlanType } from '@/types/quota';
import { navigateToLibrary } from '@/utils/nav';
import { eventDispatcher } from '@/utils/event';
import { isTauriAppPlatform } from '@/services/environment';
import { getPlanDetails } from './utils/plan';
import { Toast } from '@/components/Toast';
import {
  purchaseIAPProduct,
  restoreIAPPurchases,
  getSubscriptionSuccessUrl as getIAPSubscriptionSuccessUrl,
} from '@/libs/payment/iap/client';
import { isPurchaseProduct } from '@/libs/payment/iap/utils';
import {
  createStripeCheckoutSession,
  redirectToStripeCheckout,
  createStripePortalSession,
  redirectToStripePortal,
  handleStripeCheckoutError,
  getSubscriptionSuccessUrl as getStripeSubscriptionSuccessUrl,
  type StripeAvailablePlan,
} from '@/libs/payment/stripe/client';
import LegalLinks from '@/components/LegalLinks';
import Spinner from '@/components/Spinner';
import ProfileHeader from './components/Header';
import UserInfo from './components/UserInfo';
import UsageStats from './components/UsageStats';
import PlansComparison from './components/PlansComparison';
import AccountActions from './components/AccountActions';
import StorageManager from './components/StorageManager';
import SharedLinksSection from './components/SharedLinksSection';
import { SyncPassphraseSection } from './components/SyncPassphraseSection';
import { SyncCategoriesSection } from './components/SyncCategoriesSection';
import Checkout from './components/Checkout';

const userSearchSchema = z.object({
  section: z.string().default('').catch(''),
});

export const Route = createFileRoute('/user/')({
  validateSearch: userSearchSchema,
  component: ProfilePage,
});

type CheckoutState = {
  clientSecret: string;
  sessionId: string;
  planName: string;
};

type AccountSection = 'overview' | 'storage' | 'shared' | 'sync' | 'plans';
const ACCOUNT_SECTION_KEYS = ['overview', 'storage', 'shared', 'sync', 'plans'] as const;

function ProfilePage() {
  const _ = useTranslation();
  const router = useRouter();
  const booted = useBooted();
  const platformInfo = usePlatformInfo();
  const { user, refresh } = useAuth();
  const { safeAreaInsets, isRoundedWindow } = useThemeStore();

  const [loading, setLoading] = useState(false);
  const [showEmbeddedCheckout, setShowEmbeddedCheckout] = useState(false);
  const search = Route.useSearch();
  const [activeSection, setActiveSection] = useState<AccountSection>(() =>
    (ACCOUNT_SECTION_KEYS as readonly string[]).includes(search.section)
      ? (search.section as AccountSection)
      : 'overview',
  );
  const [checkoutState, setCheckoutState] = useState<CheckoutState>({
    clientSecret: '',
    sessionId: '',
    planName: '',
  });

  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!mounted) return;

    const isAuthenticated = user && booted;
    if (isAuthenticated) return;

    const timer = setTimeout(() => {
      router.navigate({ to: '/auth', search: { redirect: '/library' } });
    }, 1000);

    return () => clearTimeout(timer);
  }, [mounted, user, booted, router]);

  useTheme({ systemUIVisible: false });

  const { quotas, userProfilePlan = 'free' } = useQuotaStats();
  const { handleLogout, handleResetPassword, handleUpdateEmail, handleConfirmDelete } =
    useUserActions();

  const { availablePlans, iapAvailable } = useAvailablePlans({
    hasIAP: platformInfo.hasIAP,
    onError: useCallback(
      (message: string) => {
        eventDispatcher.dispatch('toast', {
          type: 'info',
          message: _(message),
        });
      },
      [_],
    ),
  });

  const handleGoBack = () => {
    if (showEmbeddedCheckout) {
      setShowEmbeddedCheckout(false);
    } else {
      navigateToLibrary(router);
    }
  };

  const handleSelectSection = (section: AccountSection) => {
    // Leaving Storage refreshes quota/usage in case files were deleted there.
    if (activeSection === 'storage' && section !== 'storage') refresh();
    setActiveSection(section);
  };

  const handleStripeSubscribe = async (productId?: string, planType: PlanType = 'subscription') => {
    if (!productId) return;

    setLoading(true);
    try {
      const { sessionId, clientSecret, url } = await createStripeCheckoutSession(
        productId,
        planType,
      );

      const foundPlan = availablePlans.find((plan) => plan.productId === productId);

      if (!foundPlan) {
        throw new Error(`Plan not found for product ID: ${productId}`);
      }

      const selectedPlan = foundPlan as StripeAvailablePlan;
      const planName = selectedPlan.product?.name || selectedPlan.productName;

      const isEmbeddedCheckout = isTauriAppPlatform();
      if (isEmbeddedCheckout && sessionId && clientSecret) {
        setShowEmbeddedCheckout(true);
        setCheckoutState({
          planName,
          clientSecret,
          sessionId,
        });
      } else {
        await redirectToStripeCheckout(url);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      handleStripeCheckoutError(errorMessage);
      eventDispatcher.dispatch('toast', {
        type: 'info',
        message: _('Failed to create checkout session'),
      });
    } finally {
      setLoading(false);
    }
  };

  const handleCheckoutSuccess = useCallback(
    (sessionId: string) => {
      setShowEmbeddedCheckout(false);
      router.navigate({ to: getStripeSubscriptionSuccessUrl(sessionId) });
    },
    [router],
  );

  const handleIAPSubscribe = async (productId?: string) => {
    if (!productId) return;

    setLoading(true);
    try {
      const purchase = await purchaseIAPProduct(productId);
      if (purchase) {
        router.navigate({ to: getIAPSubscriptionSuccessUrl(purchase) });
      }
    } catch (error) {
      console.error('IAP purchase error:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleIAPRestorePurchase = async () => {
    setLoading(true);
    try {
      const purchases = await restoreIAPPurchases();
      if (purchases.length > 0) {
        const restoredSubscriptions = purchases
          .filter((p) => !isPurchaseProduct(p.productId))
          .sort((a, b) => new Date(b.purchaseDate).getTime() - new Date(a.purchaseDate).getTime());
        const purchase = restoredSubscriptions[0];

        if (!purchase) {
          throw new Error('No subscription found in restored purchases');
        }
        router.navigate({ to: getIAPSubscriptionSuccessUrl(purchase) });
      } else {
        eventDispatcher.dispatch('toast', {
          type: 'info',
          message: _('No purchases found to restore.'),
        });
      }
    } catch (error) {
      console.error('Failed to restore purchases:', error);
      eventDispatcher.dispatch('toast', {
        type: 'info',
        message: _('Failed to restore purchases.'),
      });
    }
    setLoading(false);
  };

  const handleManageSubscription = async () => {
    setLoading(true);
    try {
      const url = await createStripePortalSession();
      await redirectToStripePortal(url);
    } catch (error) {
      console.error('Error creating portal session:', error);
      eventDispatcher.dispatch('toast', {
        type: 'info',
        message: _('Failed to manage subscription.'),
      });
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteWithMessage = () => {
    handleConfirmDelete(_('Failed to delete user. Please try again later.'));
  };

  if (!mounted) {
    return null;
  }

  if (!user || !booted) {
    return (
      <div className='mx-auto max-w-4xl px-4 py-8'>
        <div className='eink-bordered border-base-200 bg-base-100 overflow-hidden rounded-lg border'>
          <div className='flex min-h-[300px] items-center justify-center p-6'>
            <div className='text-base-content animate-pulse'>{_('Loading profile...')}</div>
          </div>
        </div>
      </div>
    );
  }

  // better-auth's user has `image` (canonical avatar URL) and `name`
  // (display name) as first-class columns. The Supabase-era profile
  // metadata (`user_metadata.picture` / `full_name`) used by the
  // pre-Phase-7 UI is no longer populated. Social-login providers feed
  // their `picture` / `name` claims directly into these top-level
  // fields via better-auth's social-account mapping.
  const avatarUrl = user?.image ?? undefined;
  const userFullName = user?.name || '-';
  const userEmail = user?.email || '';
  const userPlanDetails =
    getPlanDetails(userProfilePlan, availablePlans) || getPlanDetails('free', availablePlans);

  const sectionNav: { key: AccountSection; label: string; icon: IconType }[] = [
    { key: 'overview', label: _('Overview'), icon: MdOutlinePerson },
    { key: 'storage', label: _('Storage'), icon: MdOutlineCloud },
    { key: 'shared', label: _('Shared Links'), icon: MdOutlineLink },
    { key: 'sync', label: _('Sync'), icon: MdOutlineSync },
    { key: 'plans', label: _('Plans'), icon: MdOutlineWorkspacePremium },
  ];

  const renderNavButton = (
    item: { key: AccountSection; label: string; icon: IconType },
    horizontal: boolean,
  ) => {
    const active = activeSection === item.key;
    const Icon = item.icon;
    return (
      <button
        key={item.key}
        type='button'
        onClick={() => handleSelectSection(item.key)}
        aria-current={active ? 'page' : undefined}
        className={clsx(
          'flex items-center gap-2.5 rounded-lg px-3 py-2 text-start transition-colors duration-150',
          'focus-visible:ring-base-content/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset',
          horizontal ? 'shrink-0 whitespace-nowrap' : 'w-full',
          active
            ? 'bg-base-300/80 text-base-content eink:eink-bordered eink:border'
            : 'text-base-content/80 hover:bg-base-200',
        )}
      >
        <Icon className='h-[1.15em] w-[1.15em] shrink-0' aria-hidden='true' />
        <span className='truncate'>{item.label}</span>
      </button>
    );
  };

  const renderSection = () => {
    switch (activeSection) {
      case 'storage':
        return <StorageManager />;
      case 'shared':
        return <SharedLinksSection />;
      case 'sync':
        return (
          <div className='flex flex-col gap-8'>
            <SyncCategoriesSection />
            <SyncPassphraseSection />
          </div>
        );
      case 'plans':
        return (
          <PlansComparison
            availablePlans={availablePlans}
            userPlan={userProfilePlan}
            onSubscribe={
              platformInfo.hasIAP && iapAvailable ? handleIAPSubscribe : handleStripeSubscribe
            }
          />
        );
      default:
        return (
          <div className='flex flex-col gap-8'>
            <UsageStats quotas={quotas} />
            <AccountActions
              userPlan={userProfilePlan}
              iapAvailable={iapAvailable}
              onLogout={handleLogout}
              onResetPassword={handleResetPassword}
              onUpdateEmail={handleUpdateEmail}
              onConfirmDelete={handleDeleteWithMessage}
              onRestorePurchase={handleIAPRestorePurchase}
              onManageSubscription={handleManageSubscription}
            />
          </div>
        );
    }
  };

  return (
    <div
      className={clsx(
        'bg-base-100 full-height inset-0 select-none overflow-hidden',
        platformInfo.hasRoundedWindow && isRoundedWindow && 'window-border rounded-window',
      )}
    >
      <div
        className='flex h-full w-full flex-col overflow-y-auto'
        style={{ paddingTop: `${safeAreaInsets?.top || 0}px` }}
      >
        <ProfileHeader onGoBack={handleGoBack} />
        {loading && (
          <div className='fixed inset-0 z-50 flex items-center justify-center'>
            <Spinner loading className='text-base-content' />
          </div>
        )}
        <div
          className={clsx(
            'mx-auto w-full max-w-5xl flex-1 px-4 pb-12 sm:px-6',
            platformInfo.hasTrafficLight ? 'pt-24' : 'pt-14',
          )}
        >
          {showEmbeddedCheckout ? (
            <div className='eink-bordered border-base-200 bg-base-100 rounded-lg border p-4'>
              <Checkout
                clientSecret={checkoutState.clientSecret}
                sessionId={checkoutState.sessionId}
                planName={checkoutState.planName}
                onSuccess={handleCheckoutSuccess}
              />
            </div>
          ) : (
            <>
              <div className='flex flex-col gap-6 lg:flex-row lg:gap-10'>
                <aside className='lg:w-64 lg:flex-shrink-0'>
                  <div className='flex flex-col gap-4 lg:sticky lg:top-4'>
                    <UserInfo
                      avatarUrl={avatarUrl}
                      userFullName={userFullName}
                      userEmail={userEmail}
                      planDetails={userPlanDetails}
                    />
                    {/* Desktop: vertical rail nav. */}
                    <nav
                      aria-label={_('Account sections')}
                      className='hidden flex-col gap-0.5 lg:flex'
                    >
                      {sectionNav.map((item) => renderNavButton(item, false))}
                    </nav>
                    {/* Mobile: the rail collapses to a horizontal scroll strip. */}
                    <nav
                      aria-label={_('Account sections')}
                      className='-mx-4 flex gap-1 overflow-x-auto px-4 lg:hidden'
                      style={{ scrollbarWidth: 'none' }}
                    >
                      {sectionNav.map((item) => renderNavButton(item, true))}
                    </nav>
                  </div>
                </aside>
                <main className='min-w-0 flex-1'>{renderSection()}</main>
              </div>
              <div className='mt-10'>
                <LegalLinks />
              </div>
            </>
          )}
        </div>
        <Toast />
      </div>
    </div>
  );
}
