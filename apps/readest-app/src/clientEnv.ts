import { createEnv } from '@t3-oss/env-core';
import { z } from 'zod';

const importMetaEnv =
  (
    import.meta as unknown as {
      env?: Record<string, string | boolean | undefined>;
    }
  ).env ?? {};
const processEnv: Record<string, string | undefined> =
  typeof process === 'undefined' ? {} : process.env;

const runtimeEnv: Record<string, string | boolean | undefined> = {
  ...importMetaEnv,
  ...processEnv,
};

const optionalString = z.string().optional();
const optionalUrl = z.url().optional();

export const clientEnv = createEnv({
  clientPrefix: 'VITE_',
  client: {
    VITE_APP_PLATFORM: z.enum(['web', 'tauri']).default('web'),
    VITE_API_BASE_URL: optionalUrl,
    VITE_NODE_BASE_URL: optionalUrl,
    VITE_BETTER_AUTH_URL: z.url().default('http://localhost:5173'),
    VITE_STORAGE_FIXED_QUOTA: z.coerce.number().int().nonnegative().optional(),
    VITE_TRANSLATION_FIXED_QUOTA: z.coerce.number().int().nonnegative().optional(),
    VITE_OBJECT_STORAGE_TYPE: z.enum(['r2', 's3']).default('s3'),

    VITE_POSTHOG_KEY: optionalString,
    VITE_POSTHOG_HOST: optionalUrl,
    VITE_DEFAULT_POSTHOG_URL_BASE64: optionalString,
    VITE_DEFAULT_POSTHOG_KEY_BASE64: optionalString,

    VITE_STRIPE_PUBLISHABLE_KEY_DEV_BASE64: optionalString,
    VITE_STRIPE_PUBLISHABLE_KEY_BASE64: optionalString,
    VITE_USE_APPLE_SIGN_IN: z.enum(['true', 'false']).default('false'),

    VITE_DIST_CHANNEL: z.string().default('readest'),
    VITE_DISABLE_UPDATER: z.enum(['true', 'false']).default('false'),
    VITE_PORTABLE_APP: z.enum(['true', 'false']).default('false'),
  },
  shared: {
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  },
  isServer:
    typeof window === 'undefined' ||
    runtimeEnv['SSR'] === true ||
    runtimeEnv['SSR'] === 'true' ||
    runtimeEnv['VITEST'] === 'true',
  runtimeEnv,
  emptyStringAsUndefined: true,
});
