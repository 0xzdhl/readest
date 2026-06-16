import { describe, it, expect, vi } from 'vitest';
import { isLanAddress, isRedirectStatus, fetchNoRedirect } from '@/utils/network';

/**
 * Tests for SSRF protection in the kosync proxy.
 * The proxy must reject requests to private/internal addresses.
 * See: https://github.com/readest/readest/security/code-scanning/14
 */
describe('isLanAddress – SSRF edge cases for proxy', () => {
  // 0.0.0.0 routes to localhost on many systems
  it('returns true for 0.0.0.0', () => {
    expect(isLanAddress('http://0.0.0.0')).toBe(true);
    expect(isLanAddress('http://0.0.0.0:8080')).toBe(true);
  });

  // Cloud metadata endpoint (169.254.x.x is already covered, but test the exact AWS one)
  it('returns true for cloud metadata IP 169.254.169.254', () => {
    expect(isLanAddress('http://169.254.169.254')).toBe(true);
    expect(isLanAddress('http://169.254.169.254/latest/meta-data/')).toBe(true);
  });

  // IPv6 loopback with brackets (URL standard format)
  it('returns true for bracket-wrapped IPv6 loopback [::1]', () => {
    expect(isLanAddress('http://[::1]')).toBe(true);
    expect(isLanAddress('http://[::1]:8080')).toBe(true);
  });

  // IPv6 link-local with brackets
  it('returns true for bracket-wrapped IPv6 link-local [fe80::1]', () => {
    expect(isLanAddress('http://[fe80::1]')).toBe(true);
  });

  // IPv6 unique local with brackets
  it('returns true for bracket-wrapped IPv6 unique local [fc00::1] and [fd00::1]', () => {
    expect(isLanAddress('http://[fc00::1]')).toBe(true);
    expect(isLanAddress('http://[fd00::abc]')).toBe(true);
  });

  // Public addresses should still return false
  it('returns false for public addresses', () => {
    expect(isLanAddress('https://sync.koreader.rocks')).toBe(false);
    expect(isLanAddress('https://8.8.8.8')).toBe(false);
    expect(isLanAddress('http://[2001:db8::1]')).toBe(false);
  });

  // Hardening: full-form IPv6 loopback / mapped & translated localhost
  it('returns true for fully-expanded IPv6 loopback and IPv4-mapped loopback', () => {
    expect(isLanAddress('http://[0:0:0:0:0:0:0:1]')).toBe(true);
    expect(isLanAddress('http://[::ffff:127.0.0.1]')).toBe(true);
    expect(isLanAddress('http://[::ffff:7f00:1]')).toBe(true);
  });

  // Hardening: reserved / non-public IPv4 ranges that should never be proxied
  it('returns true for additional reserved IPv4 ranges', () => {
    // loopback whole /8, not just 127.0.0.1
    expect(isLanAddress('http://127.0.0.5')).toBe(true);
    // "this" network 0.0.0.0/8
    expect(isLanAddress('http://0.1.2.3')).toBe(true);
    // carrier-grade NAT 100.64.0.0/10 (covered) — sanity check boundary
    expect(isLanAddress('http://100.64.0.1')).toBe(true);
  });
});

describe('isRedirectStatus – reject transparent redirects (SSRF)', () => {
  it('flags 3xx responses as redirects', () => {
    expect(isRedirectStatus(301)).toBe(true);
    expect(isRedirectStatus(302)).toBe(true);
    expect(isRedirectStatus(303)).toBe(true);
    expect(isRedirectStatus(307)).toBe(true);
    expect(isRedirectStatus(308)).toBe(true);
  });

  it('does not flag non-3xx responses', () => {
    expect(isRedirectStatus(200)).toBe(false);
    expect(isRedirectStatus(204)).toBe(false);
    expect(isRedirectStatus(400)).toBe(false);
    expect(isRedirectStatus(404)).toBe(false);
    expect(isRedirectStatus(500)).toBe(false);
  });
});

describe('fetchNoRedirect – does not follow redirects', () => {
  it('passes redirect: "manual" to the underlying fetch', async () => {
    const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response('ok', { status: 200 }));
    await fetchNoRedirect('https://example.com', { method: 'GET' }, mockFetch);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const init = mockFetch.mock.calls[0]![1] as RequestInit;
    expect(init.redirect).toBe('manual');
    expect(init.method).toBe('GET');
  });

  it('returns the response as-is for a 302 without following it', async () => {
    // A 302 with redirect: 'manual' resolves to an opaque-ish 3xx response;
    // simulate the manual-mode result the proxy must refuse to follow.
    const redirectResponse = new Response(null, {
      status: 302,
      headers: { Location: 'http://169.254.169.254/latest/meta-data/' },
    });
    const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(redirectResponse);

    const res = await fetchNoRedirect('https://example.com', {}, mockFetch);
    expect(isRedirectStatus(res.status)).toBe(true);
    // crucially, fetch was only called once: no transparent follow to the
    // internal Location target.
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
