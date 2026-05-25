/// <reference types="node" />

// Provide minimal env defaults so `@/env` (validated via @t3-oss/env-core)
// loads in tests without requiring a `.env` file. Tests that need specific
// values still mock `@/env` or override `process.env` themselves; this just
// satisfies the schema's required fields so route files can be imported.
process.env['DATABASE_URL'] ??= 'postgres://test:test@localhost:5432/test';
process.env['BETTER_AUTH_SECRET'] ??= 'test-secret-not-used-at-runtime';
process.env['BETTER_AUTH_URL'] ??= 'http://localhost:5173';

// jsdom-on-Windows + vitest 4.x sometimes doesn't auto-initialize
// `localStorage` / `sessionStorage` on the global. Many tests use the bare
// global (`localStorage.clear()` / `localStorage.getItem(...)`), so fall
// back to an in-memory shim if jsdom didn't provide one. This is a no-op
// when jsdom did its job.
function installStorageShim(propName: 'localStorage' | 'sessionStorage'): void {
  if (typeof window === 'undefined') return;
  if ((window as unknown as Record<string, unknown>)[propName]) return;
  const store = new Map<string, string>();
  const shim: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (k) => (store.has(k) ? (store.get(k) as string) : null),
    setItem: (k, v) => {
      store.set(k, String(v));
    },
    removeItem: (k) => {
      store.delete(k);
    },
    key: (i) => Array.from(store.keys())[i] ?? null,
  };
  Object.defineProperty(window, propName, {
    value: shim,
    configurable: true,
    writable: true,
  });
  // Mirror to globalThis so bare `localStorage` references resolve too.
  (globalThis as unknown as Record<string, Storage>)[propName] = shim;
}

installStorageShim('localStorage');
installStorageShim('sessionStorage');

// matchMedia mock
if (typeof window !== 'undefined' && !window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}
