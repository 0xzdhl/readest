import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { bearer, magicLink } from 'better-auth/plugins';
import { db } from '@/db/client';
import { sendEmail } from './email';

const env = (key: string): string => process.env[key] ?? '';
const optionalEnv = (key: string): string | undefined => {
  const v = process.env[key];
  return v && v.length > 0 ? v : undefined;
};

const betterAuthUrl = optionalEnv('BETTER_AUTH_URL');

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

  socialProviders: {
    google: { clientId: env('GOOGLE_CLIENT_ID'), clientSecret: env('GOOGLE_CLIENT_SECRET') },
    github: { clientId: env('GITHUB_CLIENT_ID'), clientSecret: env('GITHUB_CLIENT_SECRET') },
    discord: { clientId: env('DISCORD_CLIENT_ID'), clientSecret: env('DISCORD_CLIENT_SECRET') },
    apple: { clientId: env('APPLE_CLIENT_ID'), clientSecret: env('APPLE_CLIENT_SECRET') },
  },

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
    additionalFields: {
      plan: { type: 'string', defaultValue: 'free' },
      storage_usage_bytes: { type: 'number', defaultValue: 0 },
      storage_purchased_bytes: { type: 'number', defaultValue: 0 },
    },
  },

  secret: optionalEnv('BETTER_AUTH_SECRET') ?? 'dev-secret-replace-me',
  baseURL: betterAuthUrl ?? 'http://localhost:3000',
  trustedOrigins: [
    'readest://',
    'http://localhost:*',
    ...(betterAuthUrl ? [betterAuthUrl] : []),
  ],
});

export type Auth = typeof auth;
export type Session = Awaited<ReturnType<typeof auth.api.getSession>>;
