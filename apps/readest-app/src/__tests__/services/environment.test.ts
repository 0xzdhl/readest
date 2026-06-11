import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

// We need to reset modules between tests to pick up env var changes,
// so we import dynamically in each test or test group.

const PUBLIC_ENV_KEYS = [
  'VITE_APP_PLATFORM',
  'VITE_API_BASE_URL',
  'VITE_NODE_BASE_URL',
  'VITE_WEBSITE_URL',
  'VITE_DOWNLOAD_BASE_URL',
  'VITE_SUPPORT_EMAIL',
  'VITE_BRAND_NAME',
] as const;

const setPublicEnv = (key: (typeof PUBLIC_ENV_KEYS)[number], value: string) => {
  vi.stubEnv(key, value);
};

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.stubEnv('DATABASE_URL', 'postgres://postgres:postgres@localhost:5432/postgres');
  vi.stubEnv('BETTER_AUTH_SECRET', 'test-secret');
  vi.stubEnv('BETTER_AUTH_URL', 'http://localhost:5173');
  // Provide valid baseline URLs so clientEnv validation passes on re-import.
  // These are required vars (no fallback); tests that need a specific value
  // re-stub via setPublicEnv(). Tests that need the var absent stub it to ''
  // after this baseline and rely on clientEnv throwing at import time.
  vi.stubEnv('VITE_API_BASE_URL', 'https://web.example.com');
  vi.stubEnv('VITE_NODE_BASE_URL', 'https://node.example.com');
  vi.stubEnv('VITE_WEBSITE_URL', 'https://www.example.com');
  vi.stubEnv('VITE_DOWNLOAD_BASE_URL', 'https://dl.example.com/releases');
  vi.stubEnv('VITE_SUPPORT_EMAIL', 'support@example.com');
  vi.stubEnv('VITE_BRAND_NAME', 'ExampleBrand');
  // Clean up any window globals we set
  delete (window as unknown as Record<string, unknown>)['__READEST_CLI_ACCESS'];
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('environment', () => {
  // ── isTauriAppPlatform ─────────────────────────────────────────
  describe('isTauriAppPlatform', () => {
    test('returns true when VITE_APP_PLATFORM is tauri', async () => {
      setPublicEnv('VITE_APP_PLATFORM', 'tauri');
      const { isTauriAppPlatform } = await import('@/services/environment');
      expect(isTauriAppPlatform()).toBe(true);
    });

    test('returns false when VITE_APP_PLATFORM is web', async () => {
      setPublicEnv('VITE_APP_PLATFORM', 'web');
      const { isTauriAppPlatform } = await import('@/services/environment');
      expect(isTauriAppPlatform()).toBe(false);
    });

    test('returns false when VITE_APP_PLATFORM is not set', async () => {
      const { isTauriAppPlatform } = await import('@/services/environment');
      expect(isTauriAppPlatform()).toBe(false);
    });
  });

  // ── isWebAppPlatform ───────────────────────────────────────────
  describe('isWebAppPlatform', () => {
    test('returns true when VITE_APP_PLATFORM is web', async () => {
      setPublicEnv('VITE_APP_PLATFORM', 'web');
      const { isWebAppPlatform } = await import('@/services/environment');
      expect(isWebAppPlatform()).toBe(true);
    });

    test('returns false when VITE_APP_PLATFORM is tauri', async () => {
      setPublicEnv('VITE_APP_PLATFORM', 'tauri');
      const { isWebAppPlatform } = await import('@/services/environment');
      expect(isWebAppPlatform()).toBe(false);
    });

    test('returns true when VITE_APP_PLATFORM is not set', async () => {
      const { isWebAppPlatform } = await import('@/services/environment');
      expect(isWebAppPlatform()).toBe(true);
    });
  });

  // ── hasCli ─────────────────────────────────────────────────────
  describe('hasCli', () => {
    test('returns true when __READEST_CLI_ACCESS is true', async () => {
      window.__READEST_CLI_ACCESS = true;
      const { hasCli } = await import('@/services/environment');
      expect(hasCli()).toBe(true);
    });

    test('returns false when __READEST_CLI_ACCESS is not set', async () => {
      const { hasCli } = await import('@/services/environment');
      expect(hasCli()).toBe(false);
    });

    test('returns false when __READEST_CLI_ACCESS is explicitly false', async () => {
      window.__READEST_CLI_ACCESS = false;
      const { hasCli } = await import('@/services/environment');
      expect(hasCli()).toBe(false);
    });
  });

  // ── isPWA ──────────────────────────────────────────────────────
  describe('isPWA', () => {
    test('returns false by default (jsdom matchMedia mock returns false)', async () => {
      const { isPWA } = await import('@/services/environment');
      expect(isPWA()).toBe(false);
    });

    test('returns true when display-mode is standalone', async () => {
      const originalMatchMedia = window.matchMedia;
      window.matchMedia = vi
        .fn()
        .mockReturnValue({ matches: true }) as unknown as typeof window.matchMedia;

      const { isPWA } = await import('@/services/environment');
      expect(isPWA()).toBe(true);

      window.matchMedia = originalMatchMedia;
    });
  });

  // ── getBaseUrl ─────────────────────────────────────────────────
  describe('getBaseUrl', () => {
    test('returns VITE_API_BASE_URL when set', async () => {
      setPublicEnv('VITE_API_BASE_URL', 'https://custom-api.example.com');
      const { getBaseUrl } = await import('@/services/environment');
      expect(getBaseUrl()).toBe('https://custom-api.example.com');
    });

    test('throws when VITE_API_BASE_URL is unset', async () => {
      vi.stubEnv('VITE_API_BASE_URL', '');
      await expect(import('@/services/environment')).rejects.toThrow();
    });
  });

  // ── getNodeBaseUrl ─────────────────────────────────────────────
  describe('getNodeBaseUrl', () => {
    test('returns VITE_NODE_BASE_URL when set', async () => {
      setPublicEnv('VITE_NODE_BASE_URL', 'https://custom-node.example.com');
      const { getNodeBaseUrl } = await import('@/services/environment');
      expect(getNodeBaseUrl()).toBe('https://custom-node.example.com');
    });

    test('throws when VITE_NODE_BASE_URL is unset', async () => {
      vi.stubEnv('VITE_NODE_BASE_URL', '');
      await expect(import('@/services/environment')).rejects.toThrow();
    });
  });

  // ── derived url + brand getters ───────────────────────────────
  describe('derived url + brand getters', () => {
    test('getShareBaseUrl appends /s to the api base', async () => {
      vi.stubEnv('VITE_API_BASE_URL', 'https://web.example.com');
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

    test('derived getters strip a trailing slash to avoid double slashes', async () => {
      vi.stubEnv('VITE_API_BASE_URL', 'https://web.example.com/');
      vi.stubEnv('VITE_DOWNLOAD_BASE_URL', 'https://dl.example.com/releases/');
      const mod = await import('@/services/environment');
      expect(mod.getShareBaseUrl()).toBe('https://web.example.com/s');
      expect(mod.getUpdaterFileUrl()).toBe('https://dl.example.com/releases/latest.json');
    });

    test('getSupportEmail and getBrandName return their vars', async () => {
      vi.stubEnv('VITE_SUPPORT_EMAIL', 'help@example.com');
      vi.stubEnv('VITE_BRAND_NAME', 'Example Reader');
      const mod = await import('@/services/environment');
      expect(mod.getSupportEmail()).toBe('help@example.com');
      expect(mod.getBrandName()).toBe('Example Reader');
    });
  });

  // ── isMacPlatform ──────────────────────────────────────────────
  describe('isMacPlatform', () => {
    test('returns true when navigator.platform contains Mac', async () => {
      Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true });
      const { isMacPlatform } = await import('@/services/environment');
      expect(isMacPlatform()).toBe(true);
    });

    test('returns true when navigator.platform is iPhone', async () => {
      Object.defineProperty(navigator, 'platform', { value: 'iPhone', configurable: true });
      const { isMacPlatform } = await import('@/services/environment');
      expect(isMacPlatform()).toBe(true);
    });

    test('returns true when navigator.platform is iPad', async () => {
      Object.defineProperty(navigator, 'platform', { value: 'iPad', configurable: true });
      const { isMacPlatform } = await import('@/services/environment');
      expect(isMacPlatform()).toBe(true);
    });

    test('returns true when navigator.platform is iPod', async () => {
      Object.defineProperty(navigator, 'platform', { value: 'iPod', configurable: true });
      const { isMacPlatform } = await import('@/services/environment');
      expect(isMacPlatform()).toBe(true);
    });

    test('returns false when navigator.platform is Win32', async () => {
      Object.defineProperty(navigator, 'platform', { value: 'Win32', configurable: true });
      const { isMacPlatform } = await import('@/services/environment');
      expect(isMacPlatform()).toBe(false);
    });

    test('returns false when navigator.platform is Linux', async () => {
      Object.defineProperty(navigator, 'platform', { value: 'Linux x86_64', configurable: true });
      const { isMacPlatform } = await import('@/services/environment');
      expect(isMacPlatform()).toBe(false);
    });
  });

  // ── getCommandPaletteShortcut ──────────────────────────────────
  describe('getCommandPaletteShortcut', () => {
    test('returns Mac shortcut on Mac platforms', async () => {
      Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true });
      const { getCommandPaletteShortcut } = await import('@/services/environment');
      expect(getCommandPaletteShortcut()).toContain('P');
    });

    test('returns Ctrl shortcut on non-Mac platforms', async () => {
      Object.defineProperty(navigator, 'platform', { value: 'Win32', configurable: true });
      const { getCommandPaletteShortcut } = await import('@/services/environment');
      expect(getCommandPaletteShortcut()).toBe('Ctrl+Shift+P');
    });
  });

  // ── getAPIBaseUrl ──────────────────────────────────────────────
  describe('getAPIBaseUrl', () => {
    test('returns /api in web development mode', async () => {
      vi.stubEnv('NODE_ENV', 'development');
      setPublicEnv('VITE_APP_PLATFORM', 'web');
      const { getAPIBaseUrl } = await import('@/services/environment');
      expect(getAPIBaseUrl()).toBe('/api');
    });

    test('returns full URL in production', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      setPublicEnv('VITE_APP_PLATFORM', 'web');
      const { getAPIBaseUrl } = await import('@/services/environment');
      expect(getAPIBaseUrl()).toBe('https://web.example.com/api');
    });

    test('returns full URL for tauri platform even in development', async () => {
      vi.stubEnv('NODE_ENV', 'development');
      setPublicEnv('VITE_APP_PLATFORM', 'tauri');
      const { getAPIBaseUrl } = await import('@/services/environment');
      expect(getAPIBaseUrl()).toBe('https://web.example.com/api');
    });
  });

  // ── getNodeAPIBaseUrl ──────────────────────────────────────────
  describe('getNodeAPIBaseUrl', () => {
    test('returns /api in web development mode', async () => {
      vi.stubEnv('NODE_ENV', 'development');
      setPublicEnv('VITE_APP_PLATFORM', 'web');
      const { getNodeAPIBaseUrl } = await import('@/services/environment');
      expect(getNodeAPIBaseUrl()).toBe('/api');
    });

    test('returns full node URL in production', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      setPublicEnv('VITE_APP_PLATFORM', 'web');
      const { getNodeAPIBaseUrl } = await import('@/services/environment');
      expect(getNodeAPIBaseUrl()).toBe('https://node.example.com/api');
    });

    test('returns full node URL for tauri platform even in development', async () => {
      vi.stubEnv('NODE_ENV', 'development');
      setPublicEnv('VITE_APP_PLATFORM', 'tauri');
      const { getNodeAPIBaseUrl } = await import('@/services/environment');
      expect(getNodeAPIBaseUrl()).toBe('https://node.example.com/api');
    });
  });
});
