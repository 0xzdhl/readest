export const isLanAddress = (url: string) => {
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname;

    if (hostname === 'localhost' || hostname === '0.0.0.0') {
      return true;
    }

    // Check for IPv4 private ranges
    const ipv4Regex = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
    const match = hostname.match(ipv4Regex);

    if (match) {
      const [, a, b, c, d] = match.map(Number);
      if (a === undefined || b === undefined || c === undefined || d === undefined) {
        return false;
      }

      // Validate IP format
      if (a > 255 || b > 255 || c > 255 || d > 255) {
        return false;
      }

      // Check private / reserved IP ranges:
      // 0.0.0.0/8 ("this" network, routes to localhost on many stacks)
      if (a === 0) return true;

      // 127.0.0.0/8 (entire loopback range, not just 127.0.0.1)
      if (a === 127) return true;

      // 10.0.0.0/8 (10.0.0.0 to 10.255.255.255)
      if (a === 10) return true;

      // 172.16.0.0/12 (172.16.0.0 to 172.31.255.255)
      if (a === 172 && b >= 16 && b <= 31) return true;

      // 192.168.0.0/16 (192.168.0.0 to 192.168.255.255)
      if (a === 192 && b === 168) return true;

      // 169.254.0.0/16 (link-local addresses, incl. cloud metadata 169.254.169.254)
      if (a === 169 && b === 254) return true;

      // Tailscale / carrier-grade NAT IPv4 range: 100.64.0.0/10
      if (a === 100 && b >= 64 && b <= 127) return true;
    }

    // Check for IPv6 private addresses
    // URL.hostname wraps IPv6 in brackets, e.g. '[::1]' — strip them
    const ipv6 = (hostname.startsWith('[') ? hostname.slice(1, -1) : hostname).toLowerCase();
    if (ipv6.includes(':')) {
      // Normalize a fully-expanded loopback ('0:0:0:0:0:0:0:1') to '::1'.
      const isExpandedLoopback = /^(0:){7}0*1$/.test(ipv6);
      // IPv4-mapped/embedded loopback, e.g. '::ffff:127.0.0.1' or '::ffff:7f00:1'.
      const isMappedLoopback =
        ipv6.includes('127.0.0.1') || /::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(ipv6);
      if (
        ipv6 === '::1' ||
        isExpandedLoopback ||
        isMappedLoopback ||
        ipv6.startsWith('fe80:') ||
        // Unique-local addresses fc00::/7 cover both fc.. and fd.. prefixes.
        ipv6.startsWith('fc') ||
        ipv6.startsWith('fd')
      ) {
        return true;
      }
    }

    return false;
  } catch {
    return false;
  }
};

/**
 * True for HTTP 3xx redirect status codes. The kosync SSRF proxy must refuse
 * to transparently follow redirects: a public, vetted `serverUrl` could 302 to
 * an internal address (cloud metadata, LAN host) that `isLanAddress` never saw.
 */
export const isRedirectStatus = (status: number): boolean => status >= 300 && status < 400;

/**
 * Fetch wrapper that disables automatic redirect following (`redirect: 'manual'`).
 * Used by the kosync proxy so that a redirect from the target server is surfaced
 * to the caller instead of being silently followed to an unvetted host. The
 * `fetchImpl` parameter exists for testability and defaults to the global fetch.
 */
export const fetchNoRedirect = (
  input: string | URL,
  init: RequestInit = {},
  fetchImpl: typeof fetch = fetch,
): Promise<Response> => fetchImpl(input, { ...init, redirect: 'manual' });
