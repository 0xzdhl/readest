import posthog from 'posthog-js';
import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { PostHogProvider } from 'posthog-js/react';
import { env } from '@/env';
import { TELEMETRY_OPT_OUT_KEY } from '@/utils/telemetry';
import { getAppVersion } from '@/utils/version';

const tryDecodeBase64 = (value: string | undefined) => {
  if (!value) return undefined;
  try {
    return atob(value);
  } catch {
    return undefined;
  }
};

const shouldDisablePostHog = () => {
  if (typeof window === 'undefined') return false;
  return localStorage.getItem(TELEMETRY_OPT_OUT_KEY) === 'true';
};

const posthogUrl = env.VITE_POSTHOG_HOST || tryDecodeBase64(env.VITE_DEFAULT_POSTHOG_URL_BASE64);
const posthogKey = env.VITE_POSTHOG_KEY || tryDecodeBase64(env.VITE_DEFAULT_POSTHOG_KEY_BASE64);

if (typeof window !== 'undefined' && env.NODE_ENV === 'production' && posthogKey) {
  if (!shouldDisablePostHog()) {
    posthog.init(posthogKey, {
      api_host: posthogUrl,
      person_profiles: 'always',
      autocapture: false,
    });
  }
}
export const CSPostHogProvider = ({ children }: { children: ReactNode }) => {
  useEffect(() => {
    posthog.register_for_session({
      $app_version: getAppVersion(),
    });
  }, []);
  return <PostHogProvider client={posthog}>{children}</PostHogProvider>;
};
