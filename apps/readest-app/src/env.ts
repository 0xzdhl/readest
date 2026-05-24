import { createEnv } from '@t3-oss/env-core';
import * as z from 'zod';

const importMetaEnv =
  (import.meta as unknown as { env?: Record<string, string | boolean | undefined> }).env ?? {};
const processEnv: Record<string, string | undefined> =
  typeof process === 'undefined' ? {} : process.env;

const runtimeEnv: Record<string, string | boolean | undefined> = {
  ...importMetaEnv,
  ...processEnv,
};

const optionalString = z.string().optional();
const optionalUrl = z.url().optional();
const optionalBase64 = z.base64().optional();

export const env = createEnv({
  server: {
    DATABASE_URL: z.url(),
    DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),

    BETTER_AUTH_SECRET: z.string().min(1),
    BETTER_AUTH_URL: z.url(),

    RESEND_API_KEY: optionalString,
    RESEND_FROM_EMAIL: z.email().default('noreply@readest.app'),
    SMTP_HOST: z.string().default('localhost'),
    SMTP_PORT: z.coerce.number().int().positive().default(1025),

    GOOGLE_CLIENT_ID: optionalString,
    GOOGLE_CLIENT_SECRET: optionalString,
    GITHUB_CLIENT_ID: optionalString,
    GITHUB_CLIENT_SECRET: optionalString,
    DISCORD_CLIENT_ID: optionalString,
    DISCORD_CLIENT_SECRET: optionalString,
    APPLE_CLIENT_ID: optionalString,
    APPLE_CLIENT_SECRET: optionalString,

    AI_GATEWAY_API_KEY: optionalString,
    AI_GATEWAY_EMBEDDING_MODEL: z.string().default('openai/text-embedding-3-small'),

    DEEPL_PRO_API_KEYS: optionalString,
    DEEPL_FREE_API_KEYS: optionalString,
    DEEPL_PRO_API: z.url().default('https://api.deepl.com/v2/translate'),
    DEEPL_FREE_API: z.url().default('https://api-free.deepl.com/v2/translate'),
    DEEPL_X_FINGERPRINT: z.string().default(''),

    R2_TOKEN_VALUE: optionalString,
    R2_ACCESS_KEY_ID: z.string().default(''),
    R2_SECRET_ACCESS_KEY: z.string().default(''),
    R2_BUCKET_NAME: z.string().default(''),
    R2_ACCOUNT_ID: z.string().default(''),
    R2_REGION: z.string().default('auto'),

    S3_ENDPOINT: z.string().default(''),
    S3_ACCESS_KEY_ID: z.string().default(''),
    S3_SECRET_ACCESS_KEY: z.string().default(''),
    S3_BUCKET_NAME: z.string().default(''),
    S3_REGION: z.string().default('auto'),

    TEMP_STORAGE_PUBLIC_BUCKET_NAME: z.string().default(''),

    STRIPE_SECRET_KEY: optionalString,
    STRIPE_SECRET_KEY_DEV: optionalString,
    STRIPE_WEBHOOK_SECRET: optionalString,

    APPLE_IAP_KEY_ID: optionalString,
    APPLE_IAP_ISSUER_ID: optionalString,
    APPLE_IAP_BUNDLE_ID: optionalString,
    APPLE_IAP_PRIVATE_KEY_BASE64: optionalBase64,
    GOOGLE_IAP_SERVICE_ACCOUNT_KEY: optionalString,

    GOOGLE_BOOKS_API_KEYS: optionalString,
  },
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
