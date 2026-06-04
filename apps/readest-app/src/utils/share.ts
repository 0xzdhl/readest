import { SHARE_TOKEN_LENGTH } from '@/services/constants';
import { getBaseUrl, getShareBaseUrl } from '@/services/environment';

export interface ShareDeepLink {
  token: string;
  // Reserved for future query params (e.g., recipient locale, share variant).
  // Currently no params are emitted, but parseShareDeepLink preserves the
  // shape so callers don't need to be updated when more arrive.
}

const TOKEN_RE = new RegExp(`^[A-Za-z0-9]{${SHARE_TOKEN_LENGTH}}$`);

const isValidToken = (raw: unknown): raw is string => typeof raw === 'string' && TOKEN_RE.test(raw);

// Canonical share URL embedded in the dialog, share sheet, and any "copy link"
// affordance. Always points at the configured web host.
export const buildShareUrl = (token: string): string => `${getShareBaseUrl()}/${token}`;

// Parses both the custom-scheme and HTTPS forms used by the deeplink ingress.
//   readest://share/{token}
//   https://<web-host>/s/{token}
// Returns null on invalid input so callers can fall through to other parsers.
export const parseShareDeepLink = (url: string): ShareDeepLink | null => {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol === 'readest:') {
    // For readest://share/{token} the host portion holds the path segment
    // before the slash. Use pathname for the token; url.host == 'share'.
    if (parsed.host !== 'share') return null;
    const token = parsed.pathname.replace(/^\/+/, '').replace(/\/+$/, '');
    return isValidToken(token) ? { token } : null;
  }
  if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
    if (!isWebShareHost(parsed.host)) return null;
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments.length !== 2 || segments[0] !== 's') return null;
    const token = segments[1]!;
    return isValidToken(token) ? { token } : null;
  }
  return null;
};

const isWebShareHost = (host: string): boolean => {
  // Matches the configured web host and sibling subdomains under the same
  // registrable domain (e.g. for preview deploys). Conservative: accepts only
  // the exact configured host or a subdomain sharing its apex, so a
  // third-party site cannot impersonate a share URL.
  const baseHost = new URL(getBaseUrl()).host;
  if (host === baseHost) return true;
  // Accept sibling subdomains under the same registrable domain (preview deploys).
  // NOTE: the apex is derived with a naive last-two-labels split, which assumes a
  // single-label TLD (e.g. example.com → example.com). Operators deploying on a
  // multi-part TLD (e.g. example.co.uk → co.uk) would get an over-broad allowlist;
  // use a Public Suffix List if you must support such domains.
  const apex = baseHost.split('.').slice(-2).join('.');
  return apex.length > 0 && (host === apex || host.endsWith(`.${apex}`));
};
