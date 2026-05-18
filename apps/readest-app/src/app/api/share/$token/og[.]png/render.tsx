import { getDownloadSignedUrl } from '@/utils/object';
import { rejectionToHttp, resolveActiveShare } from '@/libs/shareServer';
import { SHARE_PRESIGN_TTL_SECONDS } from '@/services/constants';

// JSX renderer for the share OG image. Lives in a non-route `.tsx` so it can
// be filtered out of the Tauri bundle via `routeFileIgnorePattern` in
// vite.config.ts — same trick the rest of `src/app/api/share/**/*` uses to
// keep heavy server-only code (here: Satori + resvg WASM) out of the desktop
// build.
//
// WASM-only path. The native `@resvg/resvg-js` binding cannot run on
// Cloudflare Workers (no Node addons in V8 isolates), so we dynamic-import
// `@resvg/resvg-wasm` and the bundled `.wasm` module URL the first time the
// route fires. After that the init promise is cached in module scope and
// every subsequent request re-uses the initialised instance.

const WIDTH = 1200;
const HEIGHT = 630;

// Lazy-initialised WASM-backed resvg. The `?url` import lets Vite emit the
// `.wasm` as a static asset and hand us back its public URL; the runtime
// then `fetch()`es it and feeds the bytes into `initWasm()`. Per-isolate the
// init promise resolves exactly once, so repeated OG hits don't re-decode
// the module.
let resvgReady: Promise<typeof import('@resvg/resvg-wasm')> | null = null;
const ensureResvg = (): Promise<typeof import('@resvg/resvg-wasm')> => {
  if (!resvgReady) {
    resvgReady = (async () => {
      const [resvg, wasmUrl] = await Promise.all([
        import('@resvg/resvg-wasm'),
        import('@resvg/resvg-wasm/index_bg.wasm?url').then((m) => m.default),
      ]);
      await resvg.initWasm(fetch(wasmUrl));
      return resvg;
    })();
  }
  return resvgReady;
};

// Lazy-loaded satori entrypoint. Kept symmetrical with the resvg loader so
// the heavy server-only code stays out of any client bundle if a Tauri build
// ever accidentally pulls this file in.
let satoriReady: Promise<typeof import('satori')> | null = null;
const ensureSatori = (): Promise<typeof import('satori')> => {
  if (!satoriReady) {
    satoriReady = import('satori');
  }
  return satoriReady;
};

// Cache one TTF per weight in module scope. Satori does not accept WOFF2
// (`public/fonts/` only ships WOFF2 of Inter, which Satori would reject), so
// we fetch real TTFs from Google Fonts on first OG render. The "legacy" UA
// flips the CSS response from WOFF2 to TTF — a well-known Google Fonts
// behaviour used by every Satori/OG image library that needs raw bytes.
type FontWeight = 400 | 700;
const fontCache = new Map<FontWeight, ArrayBuffer>();
const LEGACY_UA =
  'Mozilla/5.0 (X11; U; Linux i686; en-US; rv:1.9.0.4) Gecko/2008111317 Ubuntu/8.10 (intrepid) Firefox/3.0.4';

const fetchFont = async (weight: FontWeight): Promise<ArrayBuffer> => {
  const cached = fontCache.get(weight);
  if (cached) return cached;
  const cssUrl = `https://fonts.googleapis.com/css2?family=Source+Serif+4:wght@${weight}&display=swap`;
  const cssResp = await fetch(cssUrl, { headers: { 'User-Agent': LEGACY_UA } });
  if (!cssResp.ok) {
    throw new Error(`Google Fonts CSS fetch failed: ${cssResp.status}`);
  }
  const css = await cssResp.text();
  const match = css.match(/src:\s*url\((https:[^)]+)\)/);
  if (!match) {
    throw new Error('Google Fonts CSS did not contain a usable font URL');
  }
  const fontUrl = match[1]!;
  const fontResp = await fetch(fontUrl);
  if (!fontResp.ok) {
    throw new Error(`Font binary fetch failed: ${fontResp.status}`);
  }
  const bytes = await fontResp.arrayBuffer();
  fontCache.set(weight, bytes);
  return bytes;
};

export const renderShareOgImage = async (token: string): Promise<Response> => {
  const result = await resolveActiveShare(token);
  if (!result.ok) {
    const { status, body } = rejectionToHttp(result.reason);
    return Response.json(body, { status });
  }
  const { share } = result;

  let coverDataUrl: string | null = null;
  if (share.coverFileKey) {
    try {
      const signedUrl = await getDownloadSignedUrl(share.coverFileKey, SHARE_PRESIGN_TTL_SECONDS);
      const response = await fetch(signedUrl);
      if (response.ok) {
        const buffer = await response.arrayBuffer();
        const contentType = response.headers.get('content-type') ?? 'image/jpeg';
        coverDataUrl = `data:${contentType};base64,${arrayBufferToBase64(buffer)}`;
      }
    } catch (err) {
      console.error('Share og.png cover fetch failed:', err);
      // Fall through to text-only card.
    }
  }

  // Load all the heavy server-only modules in parallel on the first hit.
  const [{ default: satori }, { Resvg }, regular, bold] = await Promise.all([
    ensureSatori(),
    ensureResvg(),
    fetchFont(400),
    fetchFont(700),
  ]);

  // JSX form is XSS-safe by construction: Satori escapes text content.
  // No raw HTML strings cross the boundary.
  const svg = await satori(
    coverDataUrl
      ? withCoverCard(coverDataUrl, share.bookTitle, share.bookAuthor)
      : textOnlyCard(share.bookTitle, share.bookAuthor),
    {
      width: WIDTH,
      height: HEIGHT,
      fonts: [
        { name: 'serif', data: regular, weight: 400, style: 'normal' },
        { name: 'serif', data: bold, weight: 700, style: 'normal' },
      ],
    },
  );

  const png = new Resvg(svg, { fitTo: { mode: 'width', value: WIDTH } }).render().asPng();

  return new Response(png as BodyInit, {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=3600, s-maxage=3600',
    },
  });
};

const arrayBufferToBase64 = (buffer: ArrayBuffer): string => {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
};

// Cover-on-left composition. Asymmetric (anti-slop). Cover is the visual
// anchor; metadata sits to the right with strong vertical hierarchy.
const withCoverCard = (cover: string, title: string, author: string | null) => (
  <div
    style={{
      width: '100%',
      height: '100%',
      display: 'flex',
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: '#ffffff',
      padding: '64px',
      gap: '64px',
      fontFamily: 'serif',
    }}
  >
    <img
      src={cover}
      width={320}
      height={480}
      style={{
        objectFit: 'cover',
        border: '1px solid #e5e5e5',
        boxShadow: '0 6px 24px rgba(0,0,0,0.08)',
      }}
      alt=''
    />
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        gap: '24px',
        minWidth: 0,
      }}
    >
      <div
        style={{
          fontSize: 56,
          fontWeight: 700,
          color: '#1a1a1a',
          lineHeight: 1.15,
          letterSpacing: '-0.02em',
        }}
      >
        {clamp(title, 90)}
      </div>
      {author && (
        <div style={{ fontSize: 32, color: '#525252', fontWeight: 400 }}>{clamp(author, 60)}</div>
      )}
      <div style={{ flex: 1 }} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
        <div style={{ fontSize: 22, color: '#0066cc', fontWeight: 500 }}>Shared via Readest</div>
        <div style={{ fontSize: 18, color: '#a3a3a3' }}>readest.com</div>
      </div>
    </div>
  </div>
);

// Cover-less fallback. Title becomes the visual anchor at display size.
// No placeholder rectangle, no procedural pattern.
const textOnlyCard = (title: string, author: string | null) => (
  <div
    style={{
      width: '100%',
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'space-between',
      backgroundColor: '#ffffff',
      padding: '96px 80px',
      fontFamily: 'serif',
    }}
  >
    <div style={{ display: 'flex', flexDirection: 'column', gap: '32px' }}>
      <div
        style={{
          fontSize: 88,
          fontWeight: 700,
          color: '#1a1a1a',
          lineHeight: 1.05,
          letterSpacing: '-0.03em',
        }}
      >
        {clamp(title, 80)}
      </div>
      {author && (
        <div style={{ fontSize: 40, color: '#525252', fontWeight: 400 }}>{clamp(author, 60)}</div>
      )}
    </div>
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      <div style={{ fontSize: 26, color: '#0066cc', fontWeight: 500 }}>Shared via Readest</div>
      <div style={{ fontSize: 20, color: '#a3a3a3' }}>readest.com</div>
    </div>
  </div>
);

const clamp = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
