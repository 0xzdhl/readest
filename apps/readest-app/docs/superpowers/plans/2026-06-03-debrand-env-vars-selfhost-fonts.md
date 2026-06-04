# De-brand readest references to env vars + self-host CJK fonts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace every hardcoded `readest.com`/`readest.app`/`*.readest.com` reference with required environment variables (no readest fallback) and self-host the 4 CJK fonts currently fetched from `storage.readest.com`.

**Architecture:** Extend the existing `@t3-oss/env-core` + zod env layer (`clientEnv.ts`, `env.ts`). API/brand/URL values are read through getters in `src/services/environment.ts`; derived URLs (share, legal, updater) are computed from base vars. A re-runnable Node script downloads the CJK font assets into `public/vendor/fonts` and `fonts.ts` points to local paths.

**Tech Stack:** TypeScript, React, TanStack Start, Vite, Vitest, `@t3-oss/env-core`, zod, Node 18+ (global `fetch`).

**Ordering rationale:** New vars/getters are added first (additive, non-breaking), then all call sites are migrated to getters while the old constants still exist, and only afterward are the constants deleted. Every commit compiles and tests pass.

---

## File Structure

| File                                                                                            | Responsibility                                                      | Action               |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | -------------------- |
| `scripts/download-cjk-fonts.mjs`                                                                | Download + verify the 4 CJK font bundles into `public/vendor/fonts` | Create               |
| `src/styles/fonts.ts`                                                                           | Point CJK `<link>`s at local `/vendor/fonts/...` paths              | Modify (lines 41–44) |
| `src/clientEnv.ts`                                                                              | Declare new required `VITE_` vars; add `skipValidation` hatch       | Modify               |
| `src/env.ts`                                                                                    | Add `STORAGE_PUBLIC_BASE_URL`; make `RESEND_FROM_EMAIL` required    | Modify               |
| `src/services/environment.ts`                                                                   | Getters for base/website/download/support/brand + derived URLs      | Modify               |
| `src/services/constants.ts`                                                                     | Remove the readest URL literals                                     | Modify               |
| `src/utils/deeplink.ts`                                                                         | Derive web host from env base                                       | Modify               |
| `src/utils/share.ts`                                                                            | Derive share host + base from env                                   | Modify               |
| `src/middlewares/cors.ts`                                                                       | Build allow-list from env base                                      | Modify               |
| `src/components/UpdaterWindow.tsx`, `src/helpers/updater.ts`                                    | Use updater/changelog getters                                       | Modify               |
| `src/app/o/OpenAnnotationPage.tsx`, `src/app/s/shareRoute.ts`, `src/app/s/ShareLanding.tsx`     | Use getters                                                         | Modify               |
| `src/components/LegalLinks.tsx`, `src/components/landing/PageFooter.tsx`                        | Use website-url getter                                              | Modify               |
| `src/app/error.tsx`, `src/app/user/subscription/success/index.tsx`                              | Use support-email getter                                            | Modify               |
| `src/app/api/share/$token/og[.]png/render.tsx`                                                  | Use brand-name getter                                               | Modify               |
| `src/app/api/storage/upload.ts`                                                                 | Use `STORAGE_PUBLIC_BASE_URL`                                       | Modify               |
| `src/app/api/share/create/route.ts`, `src/app/api/share/list/route.ts`                          | Use share-base getter                                               | Modify               |
| `src/app/library/components/SettingsMenu.tsx`, `src/app/reader/components/sidebar/BookMenu.tsx` | Use website-url getter for download CTA                             | Modify               |
| `vitest.setup.ts`                                                                               | Hermetic defaults for new required vars                             | Modify               |
| `src/__tests__/services/environment.test.ts`                                                    | Replace fallback tests with required-var + getter tests             | Modify               |
| `src/__tests__/services/constants.test.ts`                                                      | Drop assertions for removed constants                               | Modify               |
| `.env.example`                                                                                  | Document new vars with neutral placeholders                         | Modify               |

---

## Task 1: Self-host the CJK fonts

**Files:**

- Create: `scripts/download-cjk-fonts.mjs`
- Modify: `src/styles/fonts.ts:38-51`
- Assets: `public/vendor/fonts/<Name>/` (result.css + \*.woff2)

Context: the existing local `public/vendor/fonts/<Name>/result.css` files already use relative `url("./<hash>.woff2")` paths. cn-font-split emits the same relative form remotely, so the script downloads `result.css` + every referenced `.woff2` and writes them verbatim (rewriting only if a remote path is absolute).

- [ ] **Step 1: Write the download script**

Create `scripts/download-cjk-fonts.mjs`:

```js
#!/usr/bin/env node
// Downloads the CJK font bundles that used to be fetched from the readest CDN
// and self-hosts them under public/vendor/fonts. Re-runnable / idempotent.
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_ROOT = path.resolve(__dirname, '../public/vendor/fonts');

// Source CDN base. Overridable for forks that host the bundles elsewhere.
const CDN_BASE = process.env.CJK_FONT_CDN_BASE ?? 'https://storage.readest.com/public/font/dist';

// Directory names as they appear on the CDN (and locally). The space in
// "Source Han Serif CN" is URL-encoded only when building the request URL.
const FONTS = ['Huiwen-MinchoGBK', 'KingHwa_OldSong', 'Source Han Serif CN', 'GuanKiapTsingKhai-T'];

const URL_RE = /url\(\s*["']?([^"')]+\.woff2)["']?\s*\)/g;

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.text();
}

async function fetchBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function downloadFont(name) {
  const remoteDir = `${CDN_BASE}/${encodeURIComponent(name)}`;
  const outDir = path.join(OUT_ROOT, name);
  await mkdir(outDir, { recursive: true });

  const css = await fetchText(`${remoteDir}/result.css`);

  const files = new Set();
  let rewritten = css;
  for (const m of css.matchAll(URL_RE)) {
    const ref = m[1];
    const base = ref.split('/').pop();
    files.add(base);
    // Normalize any absolute/odd ref to a sibling relative path.
    if (!ref.startsWith('./')) rewritten = rewritten.replaceAll(ref, `./${base}`);
  }

  if (files.size === 0) throw new Error(`${name}: no .woff2 references in result.css`);

  let downloaded = 0;
  for (const file of files) {
    const dest = path.join(outDir, file);
    const buf = await fetchBuffer(`${remoteDir}/${file}`);
    if (buf.byteLength === 0) throw new Error(`${name}/${file}: empty download`);
    await writeFile(dest, buf);
    downloaded += 1;
  }

  await writeFile(path.join(outDir, 'result.css'), rewritten, 'utf8');
  console.log(`  ${name}: ${downloaded} woff2 + result.css`);

  // Verify every referenced file now exists.
  for (const file of files) {
    if (!existsSync(path.join(outDir, file)))
      throw new Error(`${name}/${file}: missing after write`);
  }
}

async function main() {
  console.log(`Downloading CJK fonts from ${CDN_BASE}`);
  for (const name of FONTS) {
    await downloadFont(name);
  }
  console.log('Done. Self-hosted under public/vendor/fonts.');
}

main().catch((err) => {
  console.error('Font download failed:', err.message);
  process.exit(1);
});
```

- [ ] **Step 2: Run the script and verify output**

Run: `node scripts/download-cjk-fonts.mjs`
Expected: prints one line per font (e.g. `Huiwen-MinchoGBK: N woff2 + result.css`) and `Done.`, exit 0.

Then verify the assets exist and the CSS uses relative paths:

Run: `for d in Huiwen-MinchoGBK KingHwa_OldSong "Source Han Serif CN" GuanKiapTsingKhai-T; do echo "$d:"; ls "public/vendor/fonts/$d"/*.woff2 | wc -l; grep -c 'url("./' "public/vendor/fonts/$d/result.css"; done`
Expected: each font reports a non-zero woff2 count and a non-zero relative-url count.

- [ ] **Step 3: Point fonts.ts at the local copies**

In `src/styles/fonts.ts`, replace the four remote `storage.readest.com` links (lines 41–44) inside `getAdditionalCJKFontLinks`:

```ts
  <link rel='stylesheet' href='/vendor/fonts/Huiwen-MinchoGBK/result.css' />
  <link rel='stylesheet' href='/vendor/fonts/KingHwa_OldSong/result.css' />
  <link rel='stylesheet' href='/vendor/fonts/Source%20Han%20Serif%20CN/result.css' />
  <link rel='stylesheet' href='/vendor/fonts/GuanKiapTsingKhai-T/result.css' />
```

(Drop `crossorigin="anonymous"` — these are now same-origin. Leave the jsdelivr/cdnjs/Google lines on lines 39–40 and 45–50 unchanged.)

- [ ] **Step 4: Verify no readest font URL remains in fonts.ts**

Run: `grep -n "storage.readest.com" src/styles/fonts.ts`
Expected: no output (exit 1).

- [ ] **Step 5: Add an npm script and run lint**

In `package.json` `scripts`, add: `"fonts:download": "node scripts/download-cjk-fonts.mjs"`.

Run: `pnpm lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/download-cjk-fonts.mjs src/styles/fonts.ts package.json public/vendor/fonts
git commit -m "feat(fonts): self-host CJK fonts, drop storage.readest.com CDN"
```

---

## Task 2: Declare new required client env vars + prerender-safe validation

**Files:**

- Modify: `src/clientEnv.ts`
- Modify: `vitest.setup.ts`

- [ ] **Step 1: Add hermetic test defaults**

In `vitest.setup.ts`, after the existing `process.env[...] ??=` block (after line 9), add:

```ts
process.env['VITE_API_BASE_URL'] ??= 'https://api.test.local';
process.env['VITE_NODE_BASE_URL'] ??= 'https://node.test.local';
process.env['VITE_WEBSITE_URL'] ??= 'https://www.test.local';
process.env['VITE_DOWNLOAD_BASE_URL'] ??= 'https://download.test.local/releases';
process.env['VITE_SUPPORT_EMAIL'] ??= 'support@test.local';
process.env['VITE_BRAND_NAME'] ??= 'TestBrand';
process.env['STORAGE_PUBLIC_BASE_URL'] ??= 'https://storage.test.local';
process.env['RESEND_FROM_EMAIL'] ??= 'noreply@test.local';
```

- [ ] **Step 2: Make the API URLs required and add the new client vars**

In `src/clientEnv.ts`, change the two optional URL fields and add four new required fields in the `client` block:

```ts
    VITE_API_BASE_URL: z.url(),
    VITE_NODE_BASE_URL: z.url(),
    VITE_WEBSITE_URL: z.url(),
    VITE_DOWNLOAD_BASE_URL: z.url(),
    VITE_SUPPORT_EMAIL: z.email(),
    VITE_BRAND_NAME: z.string().min(1),
```

(`optionalUrl` may now be unused — if so, delete its declaration on line 19 to satisfy lint, or leave it if still referenced by `VITE_POSTHOG_HOST`. It is referenced by `VITE_POSTHOG_HOST`, so keep it.)

- [ ] **Step 3: Add the `skipValidation` hatch**

In `src/clientEnv.ts`, add to the `createEnv({...})` options (alongside `emptyStringAsUndefined: true`):

```ts
  skipValidation:
    runtimeEnv['SKIP_ENV_VALIDATION'] === 'true' || runtimeEnv['SKIP_ENV_VALIDATION'] === true,
```

- [ ] **Step 4: Verify the env module still type-checks and tests load**

Run: `pnpm test -- --run src/__tests__/services/environment.test.ts`
Expected: this WILL still show failures in the "falls back" cases — that's expected and fixed in Task 8. The point of this run is to confirm the module _imports_ without a validation crash (no "Invalid environment variables" thrown at import). If you see `Invalid environment variables`, the `vitest.setup.ts` defaults are missing — fix Step 1.

- [ ] **Step 5: Commit**

```bash
git add src/clientEnv.ts vitest.setup.ts
git commit -m "feat(env): make API base URLs required, add website/download/support/brand client vars"
```

---

## Task 3: Server env vars

**Files:**

- Modify: `src/env.ts:30` and the `server` block

- [ ] **Step 1: Make sender email required and add storage base**

In `src/env.ts`, change line 30 and add a new required server var:

```ts
    RESEND_FROM_EMAIL: z.email(),
```

Add (near the storage vars, e.g. after `OBJECT_STORAGE_TYPE`):

```ts
    STORAGE_PUBLIC_BASE_URL: z.url(),
```

- [ ] **Step 2: Verify server env tests still pass**

Run: `pnpm test -- --run src/__tests__/env.test.ts`
Expected: PASS (the `SKIP_ENV_VALIDATION` and required-var tests still hold; `vitest.setup.ts` provides `RESEND_FROM_EMAIL`/`STORAGE_PUBLIC_BASE_URL` defaults).

- [ ] **Step 3: Commit**

```bash
git add src/env.ts
git commit -m "feat(env): require RESEND_FROM_EMAIL, add STORAGE_PUBLIC_BASE_URL"
```

---

## Task 4: Add env-derived getters to environment.ts

**Files:**

- Modify: `src/services/environment.ts`
- Test: `src/__tests__/services/environment.test.ts` (new getter cases)

- [ ] **Step 1: Write failing tests for the new getters**

In `src/__tests__/services/environment.test.ts`, add a new describe block (after the existing `getNodeBaseUrl` block). It re-imports after stubbing, mirroring the file's pattern:

```ts
describe('derived url + brand getters', () => {
  test('getShareBaseUrl appends /s to the api base', async () => {
    setPublicEnv('VITE_API_BASE_URL', 'https://web.example.com');
    const { getShareBaseUrl } = await import('@/services/environment');
    expect(getShareBaseUrl()).toBe('https://web.example.com/s');
  });

  test('getWebsiteUrl returns VITE_WEBSITE_URL', async () => {
    vi.stubEnv('VITE_WEBSITE_URL', 'https://www.example.com');
    const { getWebsiteUrl } = await import('@/services/environment');
    expect(getWebsiteUrl()).toBe('https://www.example.com');
  });

  test('getUpdaterFileUrl and getChangelogFileUrl derive from download base', async () => {
    vi.stubEnv('VITE_DOWNLOAD_BASE_URL', 'https://dl.example.com/releases');
    const mod = await import('@/services/environment');
    expect(mod.getUpdaterFileUrl()).toBe('https://dl.example.com/releases/latest.json');
    expect(mod.getChangelogFileUrl()).toBe('https://dl.example.com/releases/release-notes.json');
  });

  test('getSupportEmail and getBrandName return their vars', async () => {
    vi.stubEnv('VITE_SUPPORT_EMAIL', 'help@example.com');
    vi.stubEnv('VITE_BRAND_NAME', 'Example Reader');
    const mod = await import('@/services/environment');
    expect(mod.getSupportEmail()).toBe('help@example.com');
    expect(mod.getBrandName()).toBe('Example Reader');
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `pnpm test -- --run src/__tests__/services/environment.test.ts -t "derived url"`
Expected: FAIL (getters not exported).

- [ ] **Step 3: Implement the getters**

In `src/services/environment.ts`, remove the constant import on line 3 and rewrite lines 15–16, adding the new getters:

```ts
import { clientEnv } from '@/clientEnv';
import type { AppService } from '@/types/system';
```

```ts
export const getBaseUrl = () => clientEnv.VITE_API_BASE_URL;
export const getNodeBaseUrl = () => clientEnv.VITE_NODE_BASE_URL;
export const getWebsiteUrl = () => clientEnv.VITE_WEBSITE_URL;
export const getDownloadBaseUrl = () => clientEnv.VITE_DOWNLOAD_BASE_URL;
export const getSupportEmail = () => clientEnv.VITE_SUPPORT_EMAIL;
export const getBrandName = () => clientEnv.VITE_BRAND_NAME;
export const getShareBaseUrl = () => `${getBaseUrl()}/s`;
export const getUpdaterFileUrl = () => `${getDownloadBaseUrl()}/latest.json`;
export const getChangelogFileUrl = () => `${getDownloadBaseUrl()}/release-notes.json`;
```

(`getAPIBaseUrl` / `getNodeAPIBaseUrl` on lines 28/31 are unchanged — they still wrap `getBaseUrl()`/`getNodeBaseUrl()`.)

- [ ] **Step 4: Run the new tests to confirm they pass**

Run: `pnpm test -- --run src/__tests__/services/environment.test.ts -t "derived url"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/environment.ts src/__tests__/services/environment.test.ts
git commit -m "feat(env): add env-derived url and brand getters"
```

---

## Task 5: Derive deeplink + share host validation from env

**Files:**

- Modify: `src/utils/deeplink.ts`
- Modify: `src/utils/share.ts`
- Test: `src/__tests__/utils/share.test.ts` (and deeplink test if present)

- [ ] **Step 1: Write failing tests for env-driven host acceptance**

In `src/__tests__/utils/share.test.ts`, add (top of file, with the other imports) a stub of the env base and assert the parser accepts the configured host. If the test file mocks `@/services/constants`, switch it to mock `@/services/environment` instead:

```ts
vi.mock('@/services/environment', () => ({
  getBaseUrl: () => 'https://web.example.com',
  getShareBaseUrl: () => 'https://web.example.com/s',
}));
```

```ts
test('accepts a share URL on the configured host', () => {
  const token = 'a'.repeat(22);
  expect(parseShareDeepLink(`https://web.example.com/s/${token}`)).toEqual({ token });
});

test('accepts a sibling subdomain under the configured apex', () => {
  const token = 'b'.repeat(22);
  expect(parseShareDeepLink(`https://preview.example.com/s/${token}`)).toEqual({ token });
});

test('rejects an unrelated host', () => {
  const token = 'c'.repeat(22);
  expect(parseShareDeepLink(`https://evil.com/s/${token}`)).toBeNull();
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm test -- --run src/__tests__/utils/share.test.ts`
Expected: FAIL (still validating against `.readest.com`).

- [ ] **Step 3: Update share.ts**

In `src/utils/share.ts`, replace the constants import (line 1) and the URL builder + host check:

```ts
import { SHARE_TOKEN_LENGTH } from '@/services/constants';
import { getBaseUrl, getShareBaseUrl } from '@/services/environment';
```

```ts
export const buildShareUrl = (token: string): string => `${getShareBaseUrl()}/${token}`;
```

```ts
const isWebShareHost = (host: string): boolean => {
  const baseHost = new URL(getBaseUrl()).host;
  if (host === baseHost) return true;
  // Accept sibling subdomains under the same registrable domain (preview deploys).
  const apex = baseHost.split('.').slice(-2).join('.');
  return apex.length > 0 && (host === apex || host.endsWith(`.${apex}`));
};
```

Update the call on the old line 38 from `isWebReadestHost(parsed.host)` to `isWebShareHost(parsed.host)`. Update the doc comment on lines 19–20 to use a neutral example (e.g. `https://web.<your-domain>/s/{token}`).

- [ ] **Step 4: Update deeplink.ts**

In `src/utils/deeplink.ts`, replace the constants import (line 1):

```ts
import { getBaseUrl } from '@/services/environment';
```

Change `buildAnnotationWebUrl` (line 18) to use `getBaseUrl()`:

```ts
const base = `${getBaseUrl()}${ANNOTATION_PATH_PREFIX}${bookHash}/annotation/${noteId}`;
```

Change the host check (lines 46–48):

```ts
const isWebHost =
  (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
  parsed.host === new URL(getBaseUrl()).host;
```

Update the doc comments on lines 13 and 32 to drop the literal `web.readest.com` (use `<your web host>`).

- [ ] **Step 5: Run tests to confirm pass**

Run: `pnpm test -- --run src/__tests__/utils/share.test.ts`
Expected: PASS. Also run the deeplink test if one exists: `pnpm test -- --run src/__tests__/utils/deeplink.test.ts` (skip if the file does not exist).

- [ ] **Step 6: Commit**

```bash
git add src/utils/share.ts src/utils/deeplink.ts src/__tests__/utils/share.test.ts
git commit -m "feat(deeplink): derive share/annotation host from configured base url"
```

---

## Task 6: Build CORS allow-list from env

**Files:**

- Modify: `src/middlewares/cors.ts:3-10`

- [ ] **Step 1: Replace the literal origin with the env base**

In `src/middlewares/cors.ts`, replace the import-less top with an import and build the list from `getBaseUrl()`:

```ts
import { createMiddleware } from '@tanstack/react-start';
import { getBaseUrl } from '@/services/environment';

const allowedOrigins = [
  getBaseUrl(),
  'https://tauri.localhost',
  'http://tauri.localhost',
  'http://localhost:3000',
  'http://localhost:3001',
  'tauri://localhost',
];
```

(`getBaseUrl()` returns the configured origin without a trailing slash, matching the `Origin` header format. The rest of the file is unchanged.)

- [ ] **Step 2: Verify lint + typecheck**

Run: `pnpm lint`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/middlewares/cors.ts
git commit -m "feat(cors): derive allowed origin from configured base url"
```

---

## Task 7: Migrate remaining call sites to getters

All edits swap a removed constant for a getter; the constants still exist at this point so the tree stays green. Group into one commit.

**Files & edits:**

- [ ] **Step 1: Updater + changelog**

`src/components/UpdaterWindow.tsx`: replace the import on line 22 with
`import { getUpdaterFileUrl, getChangelogFileUrl } from '@/services/environment';`
and replace each `READEST_UPDATER_FILE` (lines 118, 216, 253) with `getUpdaterFileUrl()` and `READEST_CHANGELOG_FILE` (line 332) with `getChangelogFileUrl()`.

`src/helpers/updater.ts`: remove the `READEST_CHANGELOG_FILE`/`READEST_UPDATER_FILE` imports (lines 13–14); add `import { getUpdaterFileUrl, getChangelogFileUrl } from '@/services/environment';`. Replace `READEST_UPDATER_FILE` (line 62) with `getUpdaterFileUrl()` and `READEST_CHANGELOG_FILE` (line 94) with `getChangelogFileUrl()`.

- [ ] **Step 2: Download CTA (website URL)**

`src/app/library/components/SettingsMenu.tsx` (line 12 import, line 94 usage) and `src/app/reader/components/sidebar/BookMenu.tsx` (line 17 import, line 59 usage): replace `import { DOWNLOAD_READEST_URL } from '@/services/constants';` with `import { getWebsiteUrl } from '@/services/environment';` and `window.open(DOWNLOAD_READEST_URL, '_blank')` with `window.open(getWebsiteUrl(), '_blank')`.

`src/app/s/ShareLanding.tsx` (line 9 import; usages at lines 141, 299): replace import with `import { getWebsiteUrl } from '@/services/environment';` and each `href={DOWNLOAD_READEST_URL}` with `href={getWebsiteUrl()}`.

`src/app/o/OpenAnnotationPage.tsx` (line 4 import; usages): replace `import { DOWNLOAD_READEST_URL, READEST_WEB_BASE_URL } from '@/services/constants';` with `import { getWebsiteUrl, getBaseUrl } from '@/services/environment';`. Replace `${READEST_WEB_BASE_URL}${webReaderUrl}` (line 66) with `${getBaseUrl()}${webReaderUrl}`, `href={DOWNLOAD_READEST_URL}` (line 172) with `href={getWebsiteUrl()}`, and the literal `href='https://readest.com'` (line 119) with `href={getWebsiteUrl()}`.

- [ ] **Step 3: Share routes + OG image host**

`src/app/s/shareRoute.ts` (line 5 import; lines 40–41): replace `import { READEST_WEB_BASE_URL, SHARE_BASE_URL } from '@/services/constants';` with `import { getBaseUrl, getShareBaseUrl } from '@/services/environment';`. Replace `${SHARE_BASE_URL}/${token}` with `${getShareBaseUrl()}/${token}` and `${READEST_WEB_BASE_URL}/api/share/${token}/og.png` with `${getBaseUrl()}/api/share/${token}/og.png`.

`src/app/api/share/create/route.ts` (line 7 import; line 193) and `src/app/api/share/list/route.ts` (line 5 import; line 86): replace the `SHARE_BASE_URL` import with `import { getShareBaseUrl } from '@/services/environment';` and use `getShareBaseUrl()` in place of `SHARE_BASE_URL` (`` `${getShareBaseUrl()}/${raw}` `` and `shareUrlBase: getShareBaseUrl()`).

- [ ] **Step 4: Legal links + footer (website URL)**

`src/components/LegalLinks.tsx`: add `import { getWebsiteUrl } from '@/services/environment';`. Replace `'https://readest.com/terms-of-service'` (line 12) with `` `${getWebsiteUrl()}/terms-of-service` `` and `href='https://readest.com/privacy-policy'` (line 20) with `href={`${getWebsiteUrl()}/privacy-policy`}`.

`src/components/landing/PageFooter.tsx`: add `import { getWebsiteUrl } from '@/services/environment';` and replace `href='https://readest.com'` (line 10) with `href={getWebsiteUrl()}`.

- [ ] **Step 5: Support email**

`src/app/error.tsx`: add `import { getSupportEmail } from '@/services/environment';` and replace `href='mailto:support@readest.com'` (line 162) with `href={`mailto:${getSupportEmail()}`}`.

`src/app/user/subscription/success/index.tsx` (line 505): replace the inlined address. Change the i18n string to interpolate, e.g.
`{_('Need help? Contact our support team at {{email}}', { email: getSupportEmail() })}`
and add `import { getSupportEmail } from '@/services/environment';`. (Confirm the `_` translation helper supports interpolation — it does elsewhere in this file; if not, concatenate: `{_('Need help? Contact our support team at')} {getSupportEmail()}`.)

- [ ] **Step 6: OG image brand text**

`src/app/api/share/$token/og[.]png/render.tsx` (lines 217, 256): add `import { getBrandName } from '@/services/environment';` and replace each `>readest.com<` text node with `>{getBrandName()}<`.

- [ ] **Step 7: Storage public base (server)**

`src/app/api/storage/upload.ts` (line 7 import; line 63): replace `import { READEST_PUBLIC_STORAGE_BASE_URL } from '@/services/constants';` with `import { env } from '@/env';` (if not already imported) and `const publicBaseUrl = READEST_PUBLIC_STORAGE_BASE_URL;` with `const publicBaseUrl = env.STORAGE_PUBLIC_BASE_URL;`.

- [ ] **Step 8: Typecheck + full test run**

Run: `pnpm lint`
Expected: PASS (no unused-import or type errors).

Run: `pnpm test`
Expected: PASS except possibly `constants.test.ts` / the old `environment.test.ts` fallback cases — those are fixed in Task 8.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "refactor: route all readest urls/brand through env getters"
```

---

## Task 8: Remove the constants + fix tests + .env.example

**Files:**

- Modify: `src/services/constants.ts:738-757`
- Modify: `src/__tests__/services/environment.test.ts`
- Modify: `src/__tests__/services/constants.test.ts`
- Modify: `.env.example`

- [ ] **Step 1: Remove the readest URL constants**

In `src/services/constants.ts`, delete these lines (738, 740–741, 743, 751, 753, 755, 757):
`DOWNLOAD_READEST_URL`, `READEST_WEB_BASE_URL`, `READEST_NODE_BASE_URL`, `SHARE_BASE_URL`, `LATEST_DOWNLOAD_BASE_URL`, `READEST_UPDATER_FILE`, `READEST_CHANGELOG_FILE`, `READEST_PUBLIC_STORAGE_BASE_URL`.
Keep `BOOK_IDS_SEPARATOR`, all `SHARE_*` numeric constants, `READEST_OPDS_USER_AGENT`, and everything else.

- [ ] **Step 2: Fix environment.test.ts fallback cases**

In `src/__tests__/services/environment.test.ts`:

- Remove the `vi.mock('@/services/constants', ...)` block (lines 4–7) — no longer referenced.
- In `beforeEach`, change the two empty-string stubs (lines 29–30) to valid URLs so module import never fails validation:

```ts
vi.stubEnv('VITE_API_BASE_URL', 'https://web.example.com');
vi.stubEnv('VITE_NODE_BASE_URL', 'https://node.example.com');
```

- Replace the `getBaseUrl` "falls back" test (lines 128–131) and the matching `getNodeBaseUrl` fallback test with required-var behavior:

```ts
test('throws when VITE_API_BASE_URL is unset', async () => {
  vi.stubEnv('VITE_API_BASE_URL', '');
  await expect(import('@/services/environment')).rejects.toThrow();
});
```

(Add the analogous case for `VITE_NODE_BASE_URL`. Keep the "returns X when set" tests.)

- [ ] **Step 3: Fix constants.test.ts**

In `src/__tests__/services/constants.test.ts`, remove the imports of the deleted constants (lines ~66, 71) and the two assertions that they are valid URLs (the `DOWNLOAD_READEST_URL` block ~861–862 and `READEST_PUBLIC_STORAGE_BASE_URL` block ~883–884). Also remove any other references to the deleted names in that file (search `READEST_WEB_BASE_URL`, `READEST_NODE_BASE_URL`, `SHARE_BASE_URL`, `READEST_UPDATER_FILE`, `READEST_CHANGELOG_FILE`).

Run: `grep -n "DOWNLOAD_READEST_URL\|READEST_WEB_BASE_URL\|READEST_NODE_BASE_URL\|SHARE_BASE_URL\|READEST_UPDATER_FILE\|READEST_CHANGELOG_FILE\|READEST_PUBLIC_STORAGE_BASE_URL" src/__tests__/services/constants.test.ts`
Expected: no output.

- [ ] **Step 4: Document new vars in .env.example**

In `.env.example`, add (no readest literals — neutral placeholders):

```
# Public-facing URLs (required). No defaults — set these for your deployment.
VITE_API_BASE_URL=https://api.example.com
VITE_NODE_BASE_URL=https://node.example.com
VITE_WEBSITE_URL=https://www.example.com
VITE_DOWNLOAD_BASE_URL=https://download.example.com/releases
VITE_SUPPORT_EMAIL=support@example.com
VITE_BRAND_NAME=Example Reader

# Server-side
STORAGE_PUBLIC_BASE_URL=https://storage.example.com
RESEND_FROM_EMAIL=noreply@example.com
```

If `VITE_API_BASE_URL`/`VITE_NODE_BASE_URL` already appear in `.env.example` (currently optional), update their placeholder values instead of duplicating, and move `RESEND_FROM_EMAIL` if it already exists.

- [ ] **Step 5: Run the full suite + lint**

Run: `pnpm test`
Expected: PASS.

Run: `pnpm lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/services/constants.ts src/__tests__ .env.example
git commit -m "refactor: remove hardcoded readest url constants, update tests + .env.example"
```

---

## Task 9: Final verification

- [ ] **Step 1: Grep for any remaining functional readest literal in source**

Run: `grep -rn "readest\.com\|readest\.app\|web\.readest\|node\.readest\|storage\.readest\|download\.readest" src --include="*.ts" --include="*.tsx" | grep -v "__tests__"`
Expected: only comment-level mentions remain, if any (e.g. the `readest://` custom scheme is NOT a domain and is fine). No `https://*.readest.com` URL literals, no `support@readest.com`, no `readest.com` UI text. Fix any stragglers, re-running the relevant task's edit.

Note: the `readest://` deeplink scheme (`buildAnnotationAppUrl`, share parser) is the app's custom URI scheme, not a domain — leave it. The `db.onlinewebfonts.com`, `fonts.googleapis.com`, jsdelivr/cdnjs font links are out of scope — leave them.

- [ ] **Step 2: Confirm fonts are local only**

Run: `grep -rn "storage.readest.com" src public/vendor/fonts/*/result.css`
Expected: no output.

- [ ] **Step 3: Full verification gate**

Run: `pnpm test`
Expected: PASS.

Run: `pnpm lint`
Expected: PASS.

(Per `.claude/rules/verification.md`: `pnpm fmt:check` / `pnpm clippy:check` only apply if `src-tauri/` changed — it did not. `pnpm test:lua` only if koplugin Lua changed — it did not.)

- [ ] **Step 4: Final commit (if any verification fixes were needed)**

```bash
git add -A
git commit -m "chore: final de-brand verification fixes"
```

---

## Self-Review Notes

- **Spec coverage:** every spec section maps to a task — env vars (T2/T3), constants removal (T8), environment.ts getters (T4), validators (T5), CORS (T6), prerender-safe validation (T2 step 3), fonts (T1), tests + `.env.example` (T8), call sites (T7), final grep gate (T9).
- **Type consistency:** getter names (`getBaseUrl`, `getNodeBaseUrl`, `getWebsiteUrl`, `getDownloadBaseUrl`, `getSupportEmail`, `getBrandName`, `getShareBaseUrl`, `getUpdaterFileUrl`, `getChangelogFileUrl`) are defined in Task 4 and used verbatim in Tasks 5–7. `env.STORAGE_PUBLIC_BASE_URL` defined in Task 3, used in Task 7.
- **Ordering:** constants are deleted (T8) only after all consumers migrate (T4–T7), so each commit compiles.
