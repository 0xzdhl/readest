#!/usr/bin/env tsx
/**
 * One-shot uploader: pushes the self-hosted CJK font bundles under
 * `public/vendor/fonts` to a Cloudflare R2 bucket so forks can serve
 * them from their own storage instead of `storage.readest.com`.
 *
 * Uses `aws4fetch` (NOT @aws-sdk/client-s3) to sign R2's S3-compatible
 * API — same client the runtime storage layer uses (src/storage/s3Compatible.ts).
 *
 * The default key prefix (`public/font/dist`) mirrors the upstream CDN
 * layout, so after upload you only need to point the downloader at your
 * bucket's public URL:
 *
 *   CJK_FONT_CDN_BASE=https://<your-r2-public-domain>/public/font/dist \
 *     pnpm setup-cjk-fonts
 *
 * Idempotent: skips objects whose size already matches (override with
 * --force). Re-runnable and safe to interrupt.
 *
 * Usage:
 *   pnpm upload-cjk-fonts                 # upload missing/changed
 *   pnpm upload-cjk-fonts -- --force      # re-upload everything
 *   pnpm upload-cjk-fonts -- --dry-run    # list what would upload
 *   pnpm upload-cjk-fonts -- --concurrency=24 --prefix=public/font/dist
 *
 * Required env (same names as the app, loaded via `dotenv -e .env`):
 *   R2_ACCOUNT_ID, R2_BUCKET_NAME, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
 * Optional:
 *   R2_REGION (default "auto"), CJK_FONT_PREFIX (default "public/font/dist")
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AwsClient } from 'aws4fetch';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FONTS_ROOT = path.resolve(__dirname, '../public/vendor/fonts');

interface Args {
  force: boolean;
  dryRun: boolean;
  concurrency: number;
  prefix: string;
  dir: string;
}

const parseArgs = (argv: string[]): Args => {
  const args: Args = {
    force: false,
    dryRun: false,
    concurrency: Number(process.env.CONCURRENCY ?? '16'),
    prefix: process.env.CJK_FONT_PREFIX ?? 'public/font/dist',
    dir: FONTS_ROOT,
  };
  for (const raw of argv) {
    if (raw === '--force') args.force = true;
    else if (raw === '--dry-run') args.dryRun = true;
    else if (raw.startsWith('--concurrency=')) args.concurrency = Number(raw.split('=')[1]);
    else if (raw.startsWith('--prefix=')) args.prefix = raw.split('=')[1] ?? args.prefix;
    else if (raw.startsWith('--dir=')) args.dir = path.resolve(raw.split('=')[1] ?? args.dir);
    else throw new Error(`Unknown argument: ${raw}`);
  }
  if (!Number.isFinite(args.concurrency) || args.concurrency < 1) {
    throw new Error(`Invalid concurrency: ${args.concurrency}`);
  }
  return args;
};

const requireEnv = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name} (load it via .env / dotenv)`);
  return v;
};

const contentTypeFor = (file: string): string => {
  if (file.endsWith('.woff2')) return 'font/woff2';
  if (file.endsWith('.css')) return 'text/css; charset=utf-8';
  if (file.endsWith('.woff')) return 'font/woff';
  if (file.endsWith('.ttf')) return 'font/ttf';
  if (file.endsWith('.otf')) return 'font/otf';
  if (file.endsWith('.json')) return 'application/json';
  return 'application/octet-stream';
};

const trimSlash = (value: string): string => value.replace(/^\/+|\/+$/g, '');
// Encode each path segment but keep the slashes — matches src/storage/s3Compatible.ts.
const encodeKey = (key: string): string => key.split('/').map(encodeURIComponent).join('/');

/** Recursively collect absolute file paths under `root`. */
const walk = async (root: string): Promise<string[]> => {
  const out: string[] = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (entry.isFile()) out.push(full);
  }
  return out;
};

interface UploadItem {
  absPath: string;
  /** R2 object key, e.g. `public/font/dist/Source Han Serif CN/abc.woff2`. */
  key: string;
  size: number;
}

type Outcome = 'uploaded' | 'skipped' | 'failed';

const headSize = async (client: AwsClient, url: string): Promise<number | null> => {
  const r = await client.fetch(url, { method: 'HEAD' });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`HEAD ${r.status}`);
  const len = r.headers.get('content-length');
  return len === null ? null : Number(len);
};

const putWithRetry = async (
  client: AwsClient,
  url: string,
  body: Uint8Array,
  contentType: string,
  attempts = 3,
): Promise<void> => {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await client.fetch(url, {
        method: 'PUT',
        body,
        headers: { 'Content-Type': contentType, 'Content-Length': body.byteLength.toString() },
      });
      if (r.ok) return;
      lastErr = new Error(`PUT ${r.status} ${r.statusText}`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
};

const uploadOne = async (
  client: AwsClient,
  endpoint: string,
  bucket: string,
  item: UploadItem,
  args: Args,
): Promise<Outcome> => {
  const url = `${trimSlash(endpoint)}/${bucket}/${encodeKey(item.key)}`;

  if (!args.force) {
    const remoteSize = await headSize(client, url);
    if (remoteSize === item.size) return 'skipped';
  }

  if (args.dryRun) return 'uploaded'; // counted as "would upload"

  const body = new Uint8Array(await readFile(item.absPath));
  await putWithRetry(client, url, body, contentTypeFor(item.absPath));
  return 'uploaded';
};

/** Run `task` over `items` with at most `limit` in flight. */
const pool = async <T>(
  items: T[],
  limit: number,
  task: (item: T, index: number) => Promise<void>,
): Promise<void> => {
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const i = cursor++;
      await task(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
};

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2));

  const accountId = requireEnv('R2_ACCOUNT_ID');
  const bucket = requireEnv('R2_BUCKET_NAME');
  const accessKeyId = requireEnv('R2_ACCESS_KEY_ID');
  const secretAccessKey = requireEnv('R2_SECRET_ACCESS_KEY');
  const region = process.env.R2_REGION ?? 'auto';
  const endpoint = `https://${accountId}.r2.cloudflarestorage.com`;

  let rootStat: Awaited<ReturnType<typeof stat>>;
  try {
    rootStat = await stat(args.dir);
  } catch {
    throw new Error(`Fonts dir not found: ${args.dir}. Run \`pnpm setup-cjk-fonts\` first.`);
  }
  if (!rootStat.isDirectory()) throw new Error(`Not a directory: ${args.dir}`);

  const files = await walk(args.dir);
  if (files.length === 0) throw new Error(`No font files under ${args.dir}`);

  const prefix = trimSlash(args.prefix);
  const items: UploadItem[] = await Promise.all(
    files.map(async (absPath): Promise<UploadItem> => {
      const rel = path.relative(args.dir, absPath).split(path.sep).join('/');
      const key = prefix ? `${prefix}/${rel}` : rel;
      const { size } = await stat(absPath);
      return { absPath, key, size };
    }),
  );

  const totalBytes = items.reduce((acc, it) => acc + it.size, 0);
  console.log(
    `Uploading ${items.length} files (${(totalBytes / 1024 / 1024).toFixed(1)} MiB) ` +
      `to r2://${bucket}/${prefix || '<root>'} ` +
      `[${args.dryRun ? 'DRY-RUN' : args.force ? 'FORCE' : 'SKIP-EXISTING'}, ` +
      `concurrency=${args.concurrency}]`,
  );

  const client = new AwsClient({ service: 's3', region, accessKeyId, secretAccessKey, retries: 0 });

  const counts: Record<Outcome, number> = { uploaded: 0, skipped: 0, failed: 0 };
  const failures: Array<{ key: string; error: string }> = [];
  let done = 0;

  await pool(items, args.concurrency, async (item) => {
    try {
      const outcome = await uploadOne(client, endpoint, bucket, item, args);
      counts[outcome]++;
    } catch (e) {
      counts.failed++;
      failures.push({ key: item.key, error: e instanceof Error ? e.message : String(e) });
    }
    done++;
    if (done % 100 === 0 || done === items.length) {
      console.log(
        `  ${done}/${items.length}  ` +
          `(${counts.uploaded} uploaded, ${counts.skipped} skipped, ${counts.failed} failed)`,
      );
    }
  });

  if (failures.length > 0) {
    console.error(`\n${failures.length} upload(s) failed:`);
    for (const f of failures.slice(0, 20)) console.error(`  ${f.key}: ${f.error}`);
    if (failures.length > 20) console.error(`  …and ${failures.length - 20} more`);
    process.exitCode = 1;
    return;
  }

  console.log(
    `\nDone. ${counts.uploaded} ${args.dryRun ? 'would upload' : 'uploaded'}, ` +
      `${counts.skipped} skipped.`,
  );
  if (!args.dryRun) {
    console.log(
      `Point the downloader at your bucket's public URL, e.g.\n` +
        `  CJK_FONT_CDN_BASE=https://<your-r2-public-domain>/${prefix} pnpm setup-cjk-fonts`,
    );
  }
};

main().catch((err: unknown) => {
  console.error('Upload failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
