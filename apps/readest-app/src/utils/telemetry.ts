import type { PostHog } from 'posthog-js';
import { clientEnv } from '@/clientEnv';
import { getAppVersion } from '@/utils/version';

export const TELEMETRY_OPT_OUT_KEY = 'readest-telemetry-opt-out';

export const hasOptedOutTelemetry = () => {
  return (
    typeof localStorage !== 'undefined' && localStorage.getItem(TELEMETRY_OPT_OUT_KEY) === 'true'
  );
};

const tryDecodeBase64 = (value: string | undefined) => {
  if (!value) return undefined;
  try {
    return atob(value);
  } catch {
    return undefined;
  }
};

// posthog-js (~60KB gz + a synchronous init() that touches the DOM/network) is
// kept off the first-paint critical path: it is imported dynamically the first
// time any telemetry call fires (or when `initTelemetry` warms it on idle).
// Every call site goes through the fire-and-forget helpers below instead of
// importing the `posthog-js` singleton directly.
let phPromise: Promise<PostHog | null> | null = null;

const loadPostHog = (): Promise<PostHog | null> => {
  if (typeof window === 'undefined') return Promise.resolve(null);
  if (!phPromise) {
    phPromise = import('posthog-js').then(({ default: posthog }) => {
      const host =
        clientEnv.VITE_POSTHOG_HOST || tryDecodeBase64(clientEnv.VITE_DEFAULT_POSTHOG_URL_BASE64);
      const key =
        clientEnv.VITE_POSTHOG_KEY || tryDecodeBase64(clientEnv.VITE_DEFAULT_POSTHOG_KEY_BASE64);
      if (clientEnv.NODE_ENV === 'production' && key && !hasOptedOutTelemetry()) {
        posthog.init(key, {
          api_host: host,
          person_profiles: 'always',
          autocapture: false,
        });
        posthog.register_for_session({ $app_version: getAppVersion() });
      }
      return posthog;
    });
  }
  return phPromise;
};

/** Warm-load posthog-js (call from an idle callback after first paint). */
export const initTelemetry = () => {
  void loadPostHog();
};

export const captureEvent = (event: string, properties?: Record<string, unknown>) => {
  if (hasOptedOutTelemetry()) return;
  void loadPostHog().then((ph) => ph?.capture(event, properties));
};

export const captureException = (error: unknown) => {
  void loadPostHog().then((ph) => ph?.captureException(error));
};

export const identifyUser = (id: string) => {
  void loadPostHog().then((ph) => ph?.identify(id));
};

export const resetUser = () => {
  void loadPostHog().then((ph) => ph?.reset());
};

export const optInTelemetry = () => {
  localStorage.setItem(TELEMETRY_OPT_OUT_KEY, 'false');
  void loadPostHog().then((ph) => ph?.opt_in_capturing());
};
export const optOutTelemetry = () => {
  localStorage.setItem(TELEMETRY_OPT_OUT_KEY, 'true');
  void loadPostHog().then((ph) => ph?.opt_out_capturing());
};
