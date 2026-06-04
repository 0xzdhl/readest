# Design: De-brand readest references to env vars + self-host CJK fonts

Date: 2026-06-03
Status: Approved (pending implementation plan)

## Problem

The app hardcodes `readest.com` / `readest.app` / `*.readest.com` domains and a
remote font CDN (`storage.readest.com`) throughout the source. For a self-hosted
or re-branded deployment this is wrong: every domain, brand string, support
email, and font source must come from configuration, not literals.

Two goals:

1. **Every** hardcoded readest reference (functional URLs, branding, contact)
   becomes an environment variable. The shipped code contains **no** readest
   literal. Vars are **required** — unset means a validation/build error, not a
   readest fallback.
2. The 4 CJK fonts currently fetched from `storage.readest.com` are downloaded
   and self-hosted in the project assets, referenced via local paths. A
   re-runnable script performs the download + verification.

## Scope

In scope:

- All `readest.com` / `readest.app` / `*.readest.com` references in
  `apps/readest-app/src`.
- The 4 readest-CDN CJK fonts (Huiwen-MinchoGBK, KingHwa_OldSong,
  Source Han Serif CN, GuanKiapTsingKhai-T).

Out of scope:

- Google Fonts API (`fonts.googleapis.com`), jsdelivr/cdnjs MiSans + LXGW, and
  the `db.onlinewebfonts.com` FangSong/Kaiti/Heiti/XiHeiti fonts stay remote —
  they are not readest references and the user scoped fonts to the readest CDN
  only.
- The shared `packages/*` workspaces (work is confined to `apps/readest-app`).

## Approach

Extend the existing env infrastructure rather than introduce a parallel config
module. The codebase already uses `@t3-oss/env-core` + zod in two files:

- `src/clientEnv.ts` — client, `VITE_` prefix, evaluated at build time, public.
- `src/env.ts` — server, validated at runtime, secrets.

A required var is simply a non-`.optional()` zod field (e.g. existing
`DATABASE_URL: z.url()`). API URLs already centralize through
`getBaseUrl()` / `getNodeBaseUrl()` in `src/services/environment.ts` with a
`?? CONSTANT` fallback — that fallback is the seam we remove.

## Environment variables

All required. No readest defaults.

### Client (`clientEnv.ts`, `VITE_` prefix — build-time, public)

| Var                      | Replaces                                                                                 | Consumers                                                                                                  |
| ------------------------ | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `VITE_API_BASE_URL`      | `READEST_WEB_BASE_URL` (`https://web.readest.com`)                                       | API base, share URL, deeplink/share host validation, CORS. Currently optional → make **required**.         |
| `VITE_NODE_BASE_URL`     | `READEST_NODE_BASE_URL` (`https://node.readest.com`)                                     | Node API base. Currently optional → make **required**.                                                     |
| `VITE_WEBSITE_URL`       | `DOWNLOAD_READEST_URL` (`https://readest.com?...`), footer/CTA homepage, legal-link base | homepage links, download CTA, `${VITE_WEBSITE_URL}/terms-of-service`, `${VITE_WEBSITE_URL}/privacy-policy` |
| `VITE_DOWNLOAD_BASE_URL` | `LATEST_DOWNLOAD_BASE_URL` (`https://download.readest.com/releases`)                     | updater `latest.json`, changelog `release-notes.json`                                                      |
| `VITE_SUPPORT_EMAIL`     | `support@readest.com`                                                                    | error page, subscription-success page                                                                      |
| `VITE_BRAND_NAME`        | the `"readest.com"` text rendered into the share OG image                                | OG image branding                                                                                          |

### Server (`env.ts`)

| Var                                  | Replaces                                                                                                             |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `STORAGE_PUBLIC_BASE_URL` (required) | `READEST_PUBLIC_STORAGE_BASE_URL` (`https://storage.readest.com`) — now used only by `src/app/api/storage/upload.ts` |
| `RESEND_FROM_EMAIL`                  | drop `noreply@readest.app` default → **required** (`z.email()`)                                                      |

Derived (not separate vars): share base = `${API_BASE_URL}/s`; legal links =
`${WEBSITE_URL}/terms-of-service` and `/privacy-policy`; updater/changelog =
`${DOWNLOAD_BASE_URL}/latest.json` and `/release-notes.json`. The path segments
are generic, not readest-branded.

## Components & changes

### 1. `src/services/constants.ts`

Remove the literals: `DOWNLOAD_READEST_URL`, `READEST_WEB_BASE_URL`,
`READEST_NODE_BASE_URL`, `SHARE_BASE_URL`, `LATEST_DOWNLOAD_BASE_URL`,
`READEST_UPDATER_FILE`, `READEST_CHANGELOG_FILE`,
`READEST_PUBLIC_STORAGE_BASE_URL`. Keep non-URL constants (`SHARE_*` numbers,
`READEST_OPDS_USER_AGENT`, regex lists).

### 2. `src/services/environment.ts`

- `getBaseUrl()` / `getNodeBaseUrl()` read `clientEnv.VITE_API_BASE_URL` /
  `VITE_NODE_BASE_URL` directly (no constant fallback).
- Add getters that derive URLs: `getShareBaseUrl()`, `getWebsiteUrl()`,
  `getDownloadBaseUrl()`, `getUpdaterFileUrl()`, `getChangelogFileUrl()`,
  `getSupportEmail()`, `getBrandName()`. (Exact placement may move to a small
  helper if `environment.ts` grows too large; decided at plan time.)

### 3. Domain validators

- `src/utils/deeplink.ts`: replace literal `web.readest.com` host check with
  `new URL(getBaseUrl()).host`.
- `src/utils/share.ts`: replace `.readest.com` suffix check with the host
  derived from `getBaseUrl()`; `SHARE_BASE_URL` / `buildShareUrl` use
  `getShareBaseUrl()`.
- `src/middlewares/cors.ts`: build the allowed-origin list from the env URL
  instead of the literal.

### 4. Call sites

Update the ~15 importers found in the inventory (e.g. `SettingsMenu.tsx`,
`BookMenu.tsx`, `OpenAnnotationPage.tsx`, `ShareLanding.tsx`, `shareRoute.ts`,
`share/create` + `share/list` routes, `LegalLinks.tsx`, `PageFooter.tsx`,
`error.tsx`, subscription `success/index.tsx`, `og.png/render.tsx`,
`storage/upload.ts`) to consume the getters / env vars instead of constants.

### 5. Prerender-safe client validation

`clientEnv.ts` currently has no `skipValidation` escape hatch. Mirror `env.ts`:
gate validation on `SKIP_ENV_VALIDATION` so the prerender pass (which evaluates
the SSR module graph without build env) does not fail, while the real
build/runtime still validates. This matches the existing pattern noted in
`env.ts` (commit af6f4f03).

### 6. Fonts — `scripts/download-cjk-fonts.mjs`

For each of the 4 fonts:

1. Fetch `https://storage.readest.com/public/font/dist/<Name>/result.css`.
2. Parse every `url(...)` reference.
3. Download each `.woff2` into `public/vendor/fonts/<Name>/` (filenames already
   hashed by `cn-font-split`).
4. Rewrite the CSS to local relative paths and write
   `public/vendor/fonts/<Name>/result.css`.
5. Verify (size > 0, count matches CSS references). Idempotent / re-runnable;
   overwrites + validates existing copies.

`src/styles/fonts.ts` lines 41–44 change from the remote `storage.readest.com`
URLs to local `/vendor/fonts/<Name>/result.css`. The space in
`Source Han Serif CN` keeps its directory name; the link href is URL-encoded as
needed.

### 7. Tests & docs

- Update `src/__tests__/services/constants.test.ts` (asserts the removed URL
  constants) and any tests mocking these URLs (environment, share, deeplink).
- Follow the repo's test-first rule: add/adjust a failing test for each
  behavioral change (validators deriving host from env, getters) before the fix.
- Add all new vars to `.env.example` with neutral placeholder values
  (`https://api.example.com`, `support@example.com`, etc.) — no readest
  literals.

## Risks / decisions

- **Required client URLs break unconfigured builds.** Intended (user chose
  "must set"). Mitigated for prerender by the `skipValidation` hatch (§5).
- **`.env.example` placeholders** are neutral, not readest values, to honor the
  "no readest literals in the repo" requirement.
- **OG image** is server-rendered; `VITE_BRAND_NAME` is read via `clientEnv`
  (readable server-side through `process.env`), consistent with how other
  `VITE_` vars are read in SSR routes.

## Verification (done-conditions)

- `pnpm test` (vitest)
- `pnpm lint` (Biome + tsgo)
- `pnpm fmt:check` + `pnpm clippy:check` only if `src-tauri/` touched (not
  expected)
- `grep -rn "readest\.com\|readest\.app" src` returns no functional literals
  (comments/branding strings all replaced)
- Font script runs clean and `fonts.ts` references only local paths for the 4
  CJK fonts; reader renders them offline.
