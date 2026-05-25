import { type BetterAuthOptions, betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer, magicLink } from "better-auth/plugins";
import type { DbClient } from "@/db/client";
import { env } from "@/env";
import { sendEmail } from "./email";

/**
 * Build a social-provider config block only when both id and secret are
 * non-empty. better-auth keeps registered providers callable even with
 * blank credentials, so unconfigured providers would return opaque
 * errors at `/api/auth/sign-in/social/<provider>`. Omitting the entry
 * entirely makes the route 404 instead, which is the desired fail-closed
 * behavior.
 */
function socialConfig(
	clientId: string | undefined,
	clientSecret: string | undefined,
) {
	if (!clientId || !clientSecret) return null;
	return { clientId, clientSecret };
}

type SocialEntry = [string, { clientId: string; clientSecret: string }];

const socialProviders: NonNullable<BetterAuthOptions["socialProviders"]> =
	Object.fromEntries(
		(
			[
				[
					"google",
					socialConfig(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET),
				],
				[
					"github",
					socialConfig(env.GITHUB_CLIENT_ID, env.GITHUB_CLIENT_SECRET),
				],
				[
					"discord",
					socialConfig(env.DISCORD_CLIENT_ID, env.DISCORD_CLIENT_SECRET),
				],
				["apple", socialConfig(env.APPLE_CLIENT_ID, env.APPLE_CLIENT_SECRET)],
			] satisfies [string, { clientId: string; clientSecret: string } | null][]
		).filter((entry): entry is SocialEntry => entry[1] !== null),
	);

const { BETTER_AUTH_SECRET: secret, BETTER_AUTH_URL: baseURL } = env;

// TODO: export this for better auth entity generation
// export const auth = betterAuth({
// 	database: drizzleAdapter(db, { provider: "pg" }),

// 	emailAndPassword: {
// 		enabled: true,
// 		requireEmailVerification: true,
// 		sendResetPassword: async ({ user, url }) => {
// 			await sendEmail({
// 				to: user.email,
// 				subject: "Reset your Readest password",
// 				html: `<p>Click <a href="${url}">here</a> to reset your password.</p>`,
// 			});
// 		},
// 	},

// 	emailVerification: {
// 		sendVerificationEmail: async ({ user, url }) => {
// 			await sendEmail({
// 				to: user.email,
// 				subject: "Verify your Readest email",
// 				html: `<p>Click <a href="${url}">here</a> to verify your email.</p>`,
// 			});
// 		},
// 	},

// 	socialProviders,

// 	plugins: [
// 		magicLink({
// 			sendMagicLink: async ({ email, url }) => {
// 				await sendEmail({
// 					to: email,
// 					subject: "Sign in to Readest",
// 					html: `<p>Click <a href="${url}">here</a> to sign in.</p>`,
// 				});
// 			},
// 		}),
// 		bearer(),
// 	],

// 	user: {
// 		// Keys MUST match the Drizzle schema's JS property names (camelCase),
// 		// not the underlying SQL column names. better-auth's drizzle adapter
// 		// resolves these against `db._.fullSchema.user[<key>]`; a snake_case
// 		// key throws `BetterAuthError: The field "<key>" does not exist in
// 		// the "user" Drizzle schema` at sign-up time. See
// 		// src/db/schema/auth.ts for the column definitions.
// 		additionalFields: {
// 			plan: { type: "string", defaultValue: "free" },
// 			storageUsageBytes: { type: "number", defaultValue: 0 },
// 			storagePurchasedBytes: { type: "number", defaultValue: 0 },
// 		},
// 		// Enable account self-deletion so `auth.api.deleteUser({ headers })`
// 		// works from /api/user/delete. Without this the endpoint returns 404
// 		// ("Delete user is disabled. Enable it in the options"). Our schema's
// 		// FK `ON DELETE CASCADE` on every business table's `user_id` column
// 		// fans the delete out automatically — we don't manually purge here.
// 		deleteUser: {
// 			enabled: true,
// 		},
// 	},

// 	secret,
// 	baseURL,
// 	trustedOrigins: ["readest://", "http://localhost:*", baseURL],
// });

export const createAuth = (db: DbClient) => {
	return betterAuth({
		database: drizzleAdapter(db, { provider: "pg" }),

		emailAndPassword: {
			enabled: true,
			requireEmailVerification: true,
			sendResetPassword: async ({ user, url }) => {
				await sendEmail({
					to: user.email,
					subject: "Reset your Readest password",
					html: `<p>Click <a href="${url}">here</a> to reset your password.</p>`,
				});
			},
		},

		emailVerification: {
			sendVerificationEmail: async ({ user, url }) => {
				await sendEmail({
					to: user.email,
					subject: "Verify your Readest email",
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
						subject: "Sign in to Readest",
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
				plan: { type: "string", defaultValue: "free" },
				storageUsageBytes: { type: "number", defaultValue: 0 },
				storagePurchasedBytes: { type: "number", defaultValue: 0 },
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
		trustedOrigins: ["readest://", "http://localhost:*", baseURL],
	});
};

export type Auth = ReturnType<typeof createAuth>;
export type Session = Awaited<ReturnType<Auth["api"]["getSession"]>>;
