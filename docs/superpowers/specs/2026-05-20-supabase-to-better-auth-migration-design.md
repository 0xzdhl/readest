# Supabase Auth → Better-Auth Migration Design

**Status:** Approved (pending spec review)
**Date:** 2026-05-20
**Branch:** `refactor/migrate-to-better-auth`
**Scope:** Replace Supabase Auth (GoTrue) and Supabase data access layer (PostgREST + supabase-js) with better-auth + drizzle-orm on the same Postgres instance.

---

## 1. Goals & Non-Goals

### Goals

- Remove every Supabase Auth (GoTrue) dependency from app and infrastructure.
- Keep Supabase Postgres as the **database host only** (no GoTrue / PostgREST / Storage-of-Supabase / Realtime).
- Define all DB schema in drizzle-orm; drizzle-kit owns migrations.
- All server-side DB access goes through drizzle directly (no PostgREST / supabase-js).
- Auth, session, user management runs entirely through better-auth.
- Preserve PostgreSQL row-level security (RLS) using **native PG mechanisms** (policies + `current_setting`), no `auth.uid()`.
- Support six login methods: email+password, magic link, Google, GitHub, Discord, Apple OAuth.
- Support three client surfaces: web (cookie session), Tauri desktop, iOS, Android (bearer token).

### Non-goals

- Preserving existing user / book / replica data. **Fresh start; all production data is discarded.**
- Maintaining backward compatibility with any Supabase SDK or PostgREST endpoint.
- Migrating magic-link login to mobile/Tauri (web-only).

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                         Clients                             │
│  Web (browser)          Tauri Desktop      iOS / Android    │
│  cookie session         bearer token        bearer token    │
└──────────────────────┬─────────────────────┬────────────────┘
                       │                     │
                       ▼                     ▼
        ┌──────────────────────────────────────────────┐
        │   TanStack Start app (apps/readest-app)      │
        │                                              │
        │   /api/auth/*   ← better-auth                │
        │     - Email/password + magic link            │
        │     - OAuth: Google/GitHub/Discord/Apple     │
        │     - bearer plugin for native clients       │
        │                                              │
        │   Server functions (sync/storage/payments/   │
        │   replica/share/...):                        │
        │     - protectedFn middleware →               │
        │       SET LOCAL app.user_id                  │
        │     - drizzle queries                        │
        └──────────────────────────────────────────────┘
                       │
                       ▼
        ┌──────────────────────────────────────────────┐
        │            Postgres (Supabase host)          │
        │   public.* schema (drizzle-managed)          │
        │     - better-auth tables (user/session/      │
        │       account/verification)                  │
        │     - business tables (books, configs,       │
        │       notes, files, replicas, ...)           │
        │     - RLS policies using                     │
        │       current_setting('app.user_id')         │
        │   No PostgREST. No auth.* schema. No GoTrue. │
        └──────────────────────────────────────────────┘
```

### Key Decisions

1. **Single DB connection role.** One Postgres role (`readest_app`) used by drizzle. Webhooks / admin paths set `app.bypass_rls=true` to escape RLS; policies include `OR current_setting('app.bypass_rls', true) = 'true'`.
2. **RLS via session variables.** Each protected request opens a transaction, runs `SET LOCAL app.user_id = '<uuid>'`, then executes the handler. Policies use `current_setting('app.user_id', true)::uuid`.
3. **Session: hybrid mode.** Web → cookie session (better-auth default). Tauri/mobile → better-auth `bearer` plugin; token stored in Tauri Store / iOS Keychain / Android EncryptedSharedPreferences.
4. **Custom claims.** Old JWT custom claims (`plan`, `storage_usage_bytes`, `storage_purchased_bytes`) become `additionalFields` on the better-auth `user` table; available on `session.user` without an extra query.
5. **JWT removed.** `jwtDecode` and the bearer-token-as-JWT path are removed; session lookups always go through better-auth's `getSession`.

---

## 3. Data Layer

### 3.1 Directory Layout

```
apps/readest-app/
├── drizzle.config.ts
└── src/
    ├── db/
    │   ├── client.ts             # pg Pool + drizzle instance
    │   ├── rls.ts                # withRls(userId, fn) helper
    │   ├── schema/
    │   │   ├── auth.ts           # better-auth tables (generated)
    │   │   ├── books.ts          # books, book_configs, book_notes
    │   │   ├── files.ts          # files
    │   │   ├── shares.ts         # book_shares
    │   │   ├── replicas.ts       # replicas, replica_keys
    │   │   ├── payments.ts       # payments, subscriptions, customers,
    │   │   │                       apple_iap_*, google_iap_*
    │   │   └── index.ts
    │   └── migrations/           # drizzle-kit output
    │       ├── 0000_init.sql
    │       └── meta/
```

### 3.2 Schema Source of Truth

- All table definitions live in `src/db/schema/*.ts`.
- The existing files **`docker/volumes/db/init/schema.sql`** and **`docker/volumes/db/migrations/001..011_*.sql`** are **deleted**.
- drizzle-kit `generate` produces `0000_init.sql`. drizzle-kit `migrate` runs at app boot in dev / via CI step in deploy.
- The better-auth schema portion is **generated** via `pnpm dlx @better-auth/cli@latest generate --config ./src/auth/server.ts --output ./src/db/schema/auth.ts` and committed.

### 3.3 RLS Strategy

- **better-auth tables (`user`, `session`, `account`, `verification`)**: RLS **not enabled**. The connection role reads/writes these directly.
- **Business tables**: RLS **enabled**. Each table has one policy:

  ```sql
  ALTER TABLE books ENABLE ROW LEVEL SECURITY;
  CREATE POLICY books_self ON books
    FOR ALL
    USING  (
      user_id = current_setting('app.user_id', true)::uuid
      OR current_setting('app.bypass_rls', true) = 'true'
    )
    WITH CHECK (
      user_id = current_setting('app.user_id', true)::uuid
      OR current_setting('app.bypass_rls', true) = 'true'
    );
  ```

- **`book_shares` (public, token-based downloads)**: writes via standard RLS (owner = `user_id`); reads via token go through a `publicFn` that does **not** call `withRls`, lookup is `WHERE token_hash = $1`.

### 3.4 `withRls` Helper

```ts
// apps/readest-app/src/db/rls.ts
import { sql } from 'drizzle-orm';
import { db } from './client';

export async function withRls<T>(
  userId: string | null,
  fn: (tx: typeof db) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    if (userId) {
      await tx.execute(sql`SELECT set_config('app.user_id', ${userId}, true)`);
    }
    return fn(tx);
  });
}

export async function withBypassRls<T>(fn: (tx: typeof db) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.bypass_rls', 'true', true)`);
    return fn(tx);
  });
}
```

### 3.5 Tables Migrated to Drizzle

From `schema.sql` + 11 migrations, the full table list to redefine in drizzle:

- `user`, `session`, `account`, `verification` (better-auth)
- `books`, `book_configs` (with `rsvp_position`), `book_notes`
- `files` (with per-replica grouping columns)
- `book_shares`
- `replica_keys`, `replicas`
- `payments`, `subscriptions`, `customers`
- `apple_iap_subscriptions`, `google_iap_subscriptions`

RPC functions:

- `increment_book_share_download` → rewrite as TypeScript with `UPDATE … RETURNING`.
- `replica_keys_insert`, `replica_keys_list`, `replica_keys_forget` → rewrite as TypeScript with drizzle queries.
- `crdt_merge_replica` (~189 lines, complex CRDT merge) → **keep as a PostgreSQL function**, ported verbatim into a custom SQL block emitted alongside drizzle's `0000_init.sql` (a `custom-after.sql` hook in drizzle migrations, or appended manually to the generated init). Invoked from server functions via drizzle's `sql` template literal. RLS context applies because the function runs inside the protected-fn transaction.

---

## 4. Auth Layer

### 4.1 Better-Auth Configuration

```
apps/readest-app/src/auth/
├── server.ts        # auth instance: drizzleAdapter + providers + plugins
├── client.ts        # createAuthClient for browser
├── tauri-client.ts  # createAuthClient for native clients (bearer)
├── email.ts         # Resend wrapper used by magicLink / verification / reset
└── handlers.ts      # request → auth.handler bridge
```

Shape of `server.ts`:

```ts
export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: 'pg' }),
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
  },
  socialProviders: {
    google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET },
    github: { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET },
    discord: { clientId: env.DISCORD_CLIENT_ID, clientSecret: env.DISCORD_CLIENT_SECRET },
    apple: { clientId: env.APPLE_CLIENT_ID, clientSecret: env.APPLE_CLIENT_SECRET },
  },
  plugins: [
    magicLink({
      sendMagicLink: async ({ email, url }) => {
        /* resend send */
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
  trustedOrigins: ['readest://', 'http://localhost:*', env.BETTER_AUTH_URL],
});
```

### 4.2 API Mount

A catch-all route at `apps/readest-app/src/routes/api/auth/$.tsx`:

```ts
export const ServerRoute = createServerFileRoute('/api/auth/$').methods({
  GET: ({ request }) => auth.handler(request),
  POST: ({ request }) => auth.handler(request),
  // PUT/DELETE/PATCH as needed
});
```

### 4.3 Protected Server Function Template

```ts
// apps/readest-app/src/lib/server/auth-fn.ts
import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { auth } from '~/auth/server';
import { withRls } from '~/db/rls';

export const protectedFn = createServerFn().middleware([
  async ({ next }) => {
    const request = getRequest();
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) throw new Response('Unauthorized', { status: 401 });
    return withRls(session.user.id, (tx) => next({ context: { user: session.user, tx } }));
  },
]);

export const publicFn = createServerFn(); // no auth, no rls context
export const serviceFn = createServerFn().middleware([
  // verify webhook signature first (per route), then enter bypass_rls
  async ({ next }) => withBypassRls((tx) => next({ context: { tx } })),
]);
```

### 4.4 Multi-Client Login Flows

| Flow                      | Web                                        | Tauri Desktop                                                                                                                                      | iOS native                                                                             | Android           |
| ------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ----------------- |
| Email + password          | `signIn.email()`                           | same                                                                                                                                               | same                                                                                   | same              |
| Magic link                | `signIn.magicLink({ email })`              | **not supported** (UI hides)                                                                                                                       | **not supported**                                                                      | **not supported** |
| Google / GitHub / Discord | `signIn.social({ provider, callbackURL })` | local `127.0.0.1:<port>` listener + `signIn.social({ provider, callbackURL: 'http://localhost:<port>/' })` → token returned in callback URL params | `signIn.social` → deep link `readest://auth-callback`                                  | same as iOS       |
| Apple OAuth               | `signIn.social({ provider: 'apple' })`     | macOS uses web flow                                                                                                                                | iOS native Apple ID → `identityToken` → `signIn.idToken({ provider: 'apple', token })` | web flow          |

### 4.5 Native Client Adapter

- `apps/readest-app/src/app/auth/utils/appleIdAuth.ts` retained; signature changes to return `identityToken` only, caller pipes to `authClient.signIn.idToken(...)`.
- `apps/readest-app/src/app/auth/utils/nativeAuth.ts` retained; the localhost-port listener and `readest://` deep-link receiver are adapted to extract the better-auth session token (from callback URL fragments / Set-Cookie) and hand it to the bearer client.

### 4.6 AuthContext Refactor

- Drop `supabase.auth.*` entirely.
- `AuthContext` derives `user`, `session`, `signOut()` from `authClient.useSession()`.
- `helpers/auth.ts` removed (no manual session finalization).
- `utils/access.ts` rewrite: no jwtDecode; read `plan` / `storage_*` directly from `session.user`.

### 4.7 Auth UI Pages

- `@supabase/auth-ui-react` + `@supabase/auth-ui-shared` uninstalled.
- Page structure unchanged:
  - `routes/auth/index.tsx` — signin/signup with all enabled methods
  - `routes/auth/callback/$.tsx` — OAuth return handler
  - `routes/auth/recovery/index.tsx` — password reset
  - `routes/auth/update/index.tsx` — change email
  - `routes/auth/error/index.tsx` — error display
- Buttons/forms re-implemented using authClient methods directly; styling intentionally preserves current ThemeSupa-equivalent look (custom Tailwind components, no new UI lib introduced).
- The magic-link button is hidden on Tauri / mobile builds (platform check).

### 4.8 Email Delivery (Resend)

- `auth/email.ts` exports a single `sendEmail({ to, subject, html })` function used by magic link, email verification (signup), and password reset.
- **Production** (when `RESEND_API_KEY` is set): use the Resend SDK.
- **Development** (no `RESEND_API_KEY`): use `nodemailer` against the local Mailpit SMTP service (`docker` exposes `1025`). The switch is a single env-driven branch inside `sendEmail`.

---

## 5. Local Dev & Infrastructure

### 5.1 docker-compose changes

```
keep:
  - db (postgres)            ← drizzle migrate at boot
  - storage (MinIO)          ← local S3-compatible backend for dev; prod uses real AWS S3 via @aws-sdk/client-s3
  - mailpit                  ← dev SMTP capture

remove:
  - auth (GoTrue)
  - rest (PostgREST)
  - kong (API gateway)
  - studio
  - meta
```

### 5.2 Environment Variables

**Added:**

- `DATABASE_URL` — `postgres://readest_app:...@db:5432/postgres`
- `BETTER_AUTH_SECRET` — 32-byte hex
- `BETTER_AUTH_URL` — e.g. `https://readest.app` / `http://localhost:3000`
- `RESEND_API_KEY`, `RESEND_FROM_EMAIL`
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`
- `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`
- `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET`
- `APPLE_CLIENT_ID` / `APPLE_CLIENT_SECRET` (or `APPLE_TEAM_ID` + `APPLE_KEY_ID` + `APPLE_PRIVATE_KEY` for JWT-signed secret)

**Removed:**

- `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`
- `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_ADMIN_KEY`
- `VITE_DEFAULT_SUPABASE_URL_BASE64`, `VITE_DEFAULT_SUPABASE_KEY_BASE64`

`apps/readest-app/.env.web.example` and `docker/.env.example` updated.

### 5.3 OAuth Provider Setup

New OAuth apps must be created for each provider. The implementation plan includes a checklist. Credentials are placeholders in `.env.example`; user provisions actual values.

Per-provider redirect URI templates (better-auth defaults):

- Web: `${BETTER_AUTH_URL}/api/auth/callback/<provider>`
- Tauri/desktop: `http://localhost:<port>/` (port assigned at runtime by nativeAuth listener)
- iOS/Android: `readest://auth-callback`

---

## 6. Commit Plan

Single PR on `refactor/migrate-to-better-auth`, organized into eight commits. Commits 1–3 are sequential (foundation). Commits 4–7 are independent and dispatched to parallel sub-agents. Commit 8 is the cleanup pass.

| #   | Commit                                                      | Owner       | Notes                                                          |
| --- | ----------------------------------------------------------- | ----------- | -------------------------------------------------------------- |
| 1   | `chore(deps): swap supabase for drizzle/better-auth/resend` | main        | package.json + lockfile only                                   |
| 2   | `feat(db): drizzle schema + RLS + migrations`               | main        | All schema files; `withRls`; drop old SQL                      |
| 3   | `feat(auth): better-auth server + clients`                  | main        | auth/, /api/auth/$, env updates, no business route changes yet |
| 4   | `refactor(api): sync/books/configs/notes → drizzle`         | sub-agent A |                                                                |
| 5   | `refactor(api): storage/replicas/shares → drizzle`          | sub-agent B | book_shares public path uses `publicFn`                        |
| 6   | `refactor(api): payments → drizzle`                         | sub-agent C | webhooks use `serviceFn` + `withBypassRls`                     |
| 7   | `refactor(ui): auth pages + AuthContext + access.ts`        | sub-agent D | hide magic-link button on Tauri/mobile                         |
| 8   | `chore: remove supabase artifacts + smoke tests`            | main        | uninstall `@supabase/*`, drop docker services, add e2e smoke   |

**Sub-agent prompts** (commits 4–7) must include: target files, the `protectedFn` / `serviceFn` / `publicFn` API contract, the `withRls` / `withBypassRls` contract, RLS expectations, test requirements, and the rule "no edits outside this commit's scope."

Shared APIs and types finalized in commits 2–3 so sub-agents don't touch each other's files.

---

## 7. Testing Strategy

| Layer                    | Tool                                                                                      | When           |
| ------------------------ | ----------------------------------------------------------------------------------------- | -------------- |
| Schema / migration       | `drizzle-kit check`; migrate to empty db                                                  | After commit 2 |
| RLS isolation            | vitest + pg test DB; SET app.user_id to user A, attempt cross-user read/write — must fail | After commit 2 |
| Auth handler integration | vitest + better-auth + drizzle against test pg; signup → signin → getSession → signout    | After commit 3 |
| API route integration    | each route: happy-path + unauthenticated (401) + cross-user (RLS-denied)                  | Commits 4–6    |
| E2E smoke                | playwright (if present) or minimal script: login → library → add book → sync              | Commit 8       |
| Native                   | manual: iOS Apple ID flow, Tauri desktop OAuth localhost callback                         | Before merge   |

---

## 8. Risks & Mitigations

| Risk                                                                                            | Mitigation                                                                                                                                                                             |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Apple Sign In configuration is fiddly (P8 key → JWT client_secret; `signIn.idToken` for native) | Implementation plan includes an Apple-specific setup checklist; verify better-auth's apple provider supports `signIn.idToken` against current docs (ctx7 query at implementation time) |
| RLS policy misconfig → silent cross-user data leak                                              | Mandatory cross-user RLS tests for every business table; review checklist before merge                                                                                                 |
| Webhook routes leaking past better-auth catch-all                                               | Mount business `/api/...` routes explicitly; `/api/auth/$` is the catch-all only under `/api/auth/`                                                                                    |
| OAuth credential provisioning blocks end-to-end test                                            | Apple may take days (Apple Developer review). Plan to verify with Google/GitHub first, defer Apple end-to-end                                                                          |
| Mailpit / Resend dev adapter complexity                                                         | Default dev path = Resend test mode; Mailpit is optional                                                                                                                               |
| `crdt_merge_replica` PG function (~189 lines) rewrite cost                                      | Keep as a PG function in `0000_init.sql`; invoke via drizzle `sql` template, not rewritten in TS                                                                                       |
| Connection pool exhaustion under RLS transactions                                               | Use `postgres-js` or `pg-pool` with reasonable max; every protected route holds a transaction — keep handler logic minimal                                                             |

---

## 9. Out-of-Scope / Deferred

- Existing data migration (fresh start).
- Two-factor auth, passkeys, account linking UI beyond what better-auth offers by default.
- Realtime/subscriptions (Supabase Realtime is being dropped; no replacement in this PR).
- Object storage is out of scope. The app already uses `@aws-sdk/client-s3` to talk to an S3 bucket directly (prod) and a local MinIO container as S3-compatible backend (dev). That stack is untouched. Only the **authorization** in front of upload/download server functions changes: previously they validated a Supabase JWT, now they go through the standard `protectedFn` middleware (better-auth `getSession` → `withRls`).

---

## 10. Open Items

None — all design questions resolved during brainstorming.
