/// <reference types="node" />

// Provide minimal env defaults so `@/env` (validated via @t3-oss/env-core)
// loads in tests without requiring a `.env` file. Tests that need specific
// values still mock `@/env` or override `process.env` themselves; this just
// satisfies the schema's required fields so route files can be imported.
process.env['DATABASE_URL'] ??= 'postgres://test:test@localhost:5432/test';
process.env['BETTER_AUTH_SECRET'] ??= 'test-secret-not-used-at-runtime';
process.env['BETTER_AUTH_URL'] ??= 'http://localhost:5173';

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
