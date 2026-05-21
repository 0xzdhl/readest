// Test-only stub for the `cloudflare:workers` virtual module. The deepl
// route does `await import('cloudflare:workers')` inside a try/catch and
// expects to fail in non-Workers environments — vite's import-analysis
// otherwise refuses to evaluate the module at all. We export `env: {}` so
// the dynamic import resolves cleanly; consumers branch on key presence
// (`env['TRANSLATIONS_KV']`) and treat absence as "no KV cache".
export const env: Record<string, unknown> = {};
