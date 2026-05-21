import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [react()],
	resolve: {
		tsconfigPaths: true,
		alias: {
			// The @pdfjs alias from tsconfig only resolves within the app's own
			// source files.  foliate-js/pdf.js lives outside that scope, so Vite
			// needs an explicit alias to find the vendored pdfjs build.
			"@pdfjs": path.resolve(__dirname, "public/vendor/pdfjs"),
			// tsconfig maps `js-mdict` to a `.d.ts` stub (types only) for typecheck;
			// at runtime tests must resolve to the actual implementation. Mirror
			// vite.config.ts so vitest can execute `MDX.create()` etc.
			"js-mdict": path.resolve(__dirname, "../../packages/js-mdict/src/index.ts"),
			// Its sources `import 'fflate'` directly — without an alias, vite's
			// import-analysis walks up from the redirected file location and fails
			// to find fflate (it's installed only in this app's node_modules).
			// Pin all `fflate` resolutions to the app's copy to keep js-mdict
			// self-contained at the source-tree level.
			fflate: path.resolve(__dirname, "node_modules/fflate"),
			// `cloudflare:workers` is the Workers-runtime virtual module the deepl
			// route dynamically imports to reach KV cache. In Node tests the call
			// site is wrapped in try/catch and the catch path is what we want
			// exercised — but vite's import-analysis still tries to statically
			// resolve the specifier and errors out. Point it at an empty stub.
			"cloudflare:workers": path.resolve(__dirname, "vitest.stubs/cloudflare-workers.ts"),
		},
	},
	test: {
		environment: "jsdom",
		setupFiles: ["./vitest.setup.ts"],
		// jsdom env startup is ~6s per file; under concurrent load individual
		// tests can exceed the 5s default. Raise the per-test timeout so
		// jsdom-heavy suites (e.g. edgeTTS WebSocket flows) don't flake.
		testTimeout: 15000,
		exclude: [
			"**/node_modules/**",
			"**/dist/**",
			"**/.claude/**",
			"**/*.browser.test.ts",
			"**/*.browser.test.tsx",
			"**/*.tauri.test.ts",
		],
		coverage: {
			provider: "v8",
			reporter: ["text", "text-summary"],
			include: ["src/**/*.{ts,tsx}"],
			exclude: ["src/**/*.d.ts", "src/**/__tests__/**", "src/**/test/**"],
		},
	},
});
