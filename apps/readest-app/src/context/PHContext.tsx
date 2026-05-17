import posthog from 'posthog-js';
import { ReactNode, useEffect } from 'react';
import { PostHogProvider } from 'posthog-js/react';
import { TELEMETRY_OPT_OUT_KEY } from '@/utils/telemetry';
import { getAppVersion } from '@/utils/version';
import { readPublicEnv } from '@/utils/publicEnv';

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

const posthogUrl =
  readPublicEnv('VITE_POSTHOG_HOST') ||
  tryDecodeBase64(readPublicEnv('VITE_DEFAULT_POSTHOG_URL_BASE64'));
const posthogKey =
  readPublicEnv('VITE_POSTHOG_KEY') ||
  tryDecodeBase64(readPublicEnv('VITE_DEFAULT_POSTHOG_KEY_BASE64'));

if (typeof window !== 'undefined' && process.env['NODE_ENV'] === 'production' && posthogKey) {
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
