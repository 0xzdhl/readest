import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

// ── Mocks for constants ──────────────────────────────────────────
vi.mock('@/services/constants', () => ({
  READEST_WEB_BASE_URL: 'https://web.readest.com',
  READEST_NODE_BASE_URL: 'https://node.readest.com',
}));

// We need to reset modules between tests to pick up env var changes,
// so we import dynamically in each test or test group.

const PUBLIC_ENV_KEYS = ['VITE_APP_PLATFORM', 'VITE_API_BASE_URL', 'VITE_NODE_BASE_URL'] as const;

const setPublicEnv = (key: (typeof PUBLIC_ENV_KEYS)[number], value: string) => {
  vi.stubEnv(key, value);
};

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.stubEnv('DATABASE_URL', 'postgres://postgres:postgres@localhost:5432/postgres');
  vi.stubEnv('BETTER_AUTH_SECRET', 'test-secret');
  vi.stubEnv('BETTER_AUTH_URL', 'http://localhost:5173');
  // Clean baseline for the base-URL vars: a local `.env` sets these to
  // http://localhost:5173, which would otherwise mask the "env var not set"
  // fallback tests below. Empty → undefined (emptyStringAsUndefined), so
  // getBaseUrl/getNodeBaseUrl hit their READEST_*_BASE_URL fallback. Tests that
  // need a value re-stub it explicitly via setPublicEnv().
  vi.stubEnv('VITE_API_BASE_URL', '');
  vi.stubEnv('VITE_NODE_BASE_URL', '');
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

    test('falls back to READEST_WEB_BASE_URL when env var not set', async () => {
      const { getBaseUrl } = await import('@/services/environment');
      expect(getBaseUrl()).toBe('https://web.readest.com');
    });
  });

  // ── getNodeBaseUrl ─────────────────────────────────────────────
  describe('getNodeBaseUrl', () => {
    test('returns VITE_NODE_BASE_URL when set', async () => {
      setPublicEnv('VITE_NODE_BASE_URL', 'https://custom-node.example.com');
      const { getNodeBaseUrl } = await import('@/services/environment');
      expect(getNodeBaseUrl()).toBe('https://custom-node.example.com');
    });

    test('falls back to READEST_NODE_BASE_URL when env var not set', async () => {
      const { getNodeBaseUrl } = await import('@/services/environment');
      expect(getNodeBaseUrl()).toBe('https://node.readest.com');
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
      expect(getAPIBaseUrl()).toBe('https://web.readest.com/api');
    });

    test('returns full URL for tauri platform even in development', async () => {
      vi.stubEnv('NODE_ENV', 'development');
      setPublicEnv('VITE_APP_PLATFORM', 'tauri');
      const { getAPIBaseUrl } = await import('@/services/environment');
      expect(getAPIBaseUrl()).toBe('https://web.readest.com/api');
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
      expect(getNodeAPIBaseUrl()).toBe('https://node.readest.com/api');
    });

    test('returns full node URL for tauri platform even in development', async () => {
      vi.stubEnv('NODE_ENV', 'development');
      setPublicEnv('VITE_APP_PLATFORM', 'tauri');
      const { getNodeAPIBaseUrl } = await import('@/services/environment');
      expect(getNodeAPIBaseUrl()).toBe('https://node.readest.com/api');
    });
  });

  // ── environmentConfig default export ───────────────────────────
  describe('environmentConfig', () => {
    test('exports an object with getAppService function', async () => {
      const envConfig = await import('@/services/environment');
      expect(typeof envConfig.default.getAppService).toBe('function');
    });
  });
});
