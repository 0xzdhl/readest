#!/usr/bin/env node
// Downloads the CJK font bundles that used to be fetched from the readest CDN
// and self-hosts them under public/vendor/fonts. Re-runnable / idempotent.
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_ROOT = path.resolve(__dirname, '../public/vendor/fonts');

// Source CDN base. Overridable for forks that host the bundles elsewhere.
const CDN_BASE =
  process.env.CJK_FONT_CDN_BASE ?? 'https://storage.readest.com/public/font/dist';

// Directory names as they appear on the CDN (and locally). The space in
// "Source Han Serif CN" is URL-encoded only when building the request URL.
const FONTS = [
  'Huiwen-MinchoGBK',
  'KingHwa_OldSong',
  'Source Han Serif CN',
  'GuanKiapTsingKhai-T',
];

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

  for (const file of files) {
    if (!existsSync(path.join(outDir, file))) throw new Error(`${name}/${file}: missing after write`);
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
