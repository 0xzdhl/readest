import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { bearer, magicLink } from 'better-auth/plugins';
import { db } from '@/db/client';
import { sendEmail } from './email';

/**
 * Return the env var if set, otherwise the dev fallback. In production
 * (`NODE_ENV === 'production'`) a missing required env throws instead —
 * better-auth's own `validateSecret` only warns for short/low-entropy
 * secrets, so without this guard a prod deploy would silently boot with
 * the dev secret / a non-https baseURL (no Secure cookie flag).
 */
function requireEnvInProd(name: string, devFallback: string): string {
  const value = process.env[name];
  if (value && value.length > 0) return value;
  if (process.env['NODE_ENV'] === 'production') {
    throw new Error(`${name} is required in production`);
  }
  return devFallback;
}

/**
 * Build a social-provider config block only when both id and secret are
 * non-empty. better-auth keeps registered providers callable even with
 * blank credentials, so unconfigured providers would return opaque
 * errors at `/api/auth/sign-in/social/<provider>`. Omitting the entry
 * entirely makes the route 404 instead, which is the desired fail-closed
 * behavior.
 */
function socialConfig(
  idEnv: string,
  secretEnv: string,
): { clientId: string; clientSecret: string } | null {
  const clientId = process.env[idEnv];
  const clientSecret = process.env[secretEnv];
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

type SocialEntry = [string, { clientId: string; clientSecret: string }];

const socialProviders: NonNullable<BetterAuthOptions['socialProviders']> = Object.fromEntries(
  (
    [
      ['google', socialConfig('GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET')],
      ['github', socialConfig('GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET')],
      ['discord', socialConfig('DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET')],
      ['apple', socialConfig('APPLE_CLIENT_ID', 'APPLE_CLIENT_SECRET')],
    ] satisfies [string, { clientId: string; clientSecret: string } | null][]
  ).filter((entry): entry is SocialEntry => entry[1] !== null),
);

const secret = requireEnvInProd('BETTER_AUTH_SECRET', 'dev-secret-replace-me');
const baseURL = requireEnvInProd('BETTER_AUTH_URL', 'http://localhost:3000');

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: 'pg' }),

  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
    sendResetPassword: async ({ user, url }) => {
      await sendEmail({
        to: user.email,
        subject: 'Reset your Readest password',
        html: `<p>Click <a href="${url}">here</a> to reset your password.</p>`,
      });
    },
  },

  emailVerification: {
    sendVerificationEmail: async ({ user, url }) => {
      await sendEmail({
        to: user.email,
        subject: 'Verify your Readest email',
        html: `<p>Click <a href="${url}">here</a> to verify your email.</p>`,
      });
    },
  },

  socialProviders,

  plugins: [
    magicLink({
      sendMagicLink: async ({ email, url }) => {
        await sendEmail({
          to: email,
          subject: 'Sign in to Readest',
          html: `<p>Click <a href="${url}">here</a> to sign in.</p>`,
        });
      },
    }),
    bearer(),
  ],

  user: {
    // Keys MUST match the Drizzle schema's JS property names (camelCase),
    // not the underlying SQL column names. better-auth's drizzle adapter
    // resolves these against `db._.fullSchema.user[<key>]`; a snake_case
    // key throws `BetterAuthError: The field "<key>" does not exist in
    // the "user" Drizzle schema` at sign-up time. See
    // src/db/schema/auth.ts for the column definitions.
    additionalFields: {
      plan: { type: 'string', defaultValue: 'free' },
      storageUsageBytes: { type: 'number', defaultValue: 0 },
      storagePurchasedBytes: { type: 'number', defaultValue: 0 },
    },
    // Enable account self-deletion so `auth.api.deleteUser({ headers })`
    // works from /api/user/delete. Without this the endpoint returns 404
    // ("Delete user is disabled. Enable it in the options"). Our schema's
    // FK `ON DELETE CASCADE` on every business table's `user_id` column
    // fans the delete out automatically — we don't manually purge here.
    deleteUser: {
      enabled: true,
    },
  },

  secret,
  baseURL,
  trustedOrigins: ['readest://', 'http://localhost:*', baseURL],
});

export type Auth = typeof auth;
export type Session = Awaited<ReturnType<typeof auth.api.getSession>>;
