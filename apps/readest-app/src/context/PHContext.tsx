import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { initTelemetry } from '@/utils/telemetry';

// No components consume the posthog React context (`usePostHog`), so we don't
// render a PostHogProvider. posthog-js is loaded + initialized lazily inside
// `@/utils/telemetry`; here we just warm it after first paint, off the
// critical path, so background session/event capture still starts promptly.
export const CSPostHogProvider = ({ children }: { children: ReactNode }) => {
  useEffect(() => {
    const ric =
      typeof window !== 'undefined' && 'requestIdleCallback' in window
        ? window.requestIdleCallback
        : (cb: () => void) => setTimeout(cb, 1000);
    const handle = ric(() => initTelemetry());
    return () => {
      if (typeof window !== 'undefined' && 'cancelIdleCallback' in window) {
        window.cancelIdleCallback(handle as number);
      } else {
        clearTimeout(handle as ReturnType<typeof setTimeout>);
      }
    };
  }, []);
  return <>{children}</>;
};
