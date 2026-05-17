import path from 'node:path';
import { defineConfig } from 'vite';
import viteReact from '@vitejs/plugin-react-swc';
import { cloudflare } from '@cloudflare/vite-plugin';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig(({ command }) => ({
  plugins: [
    tsconfigPaths(),
    // Cloudflare's dev runner currently collides with TanStack Start's SSR
    // worker path in `pnpm run dev-web`, but it is still required for web
    // build/deploy output.
    ...(command === 'build' ? [cloudflare({ viteEnvironment: { name: 'ssr' } })] : []),
    tanstackStart({
      srcDirectory: './src',
      router: {
        routesDirectory: 'app',
        routeFileIgnorePattern:
          '(components|utils|hooks|services|context|store|types|helpers|libs)|ShareLanding.tsx|SharePage.tsx|shareRoute.ts|OpenAnnotationPage.tsx|ReaderContent.tsx|ReaderRoutePage.tsx|readerSearch.ts|not-found.tsx|render.tsx',
      },
    }),
    viteReact(),
  ],
  resolve: {
    alias: [
      {
        find: /^@\/components\/ui\/(.*)/,
        replacement: path.resolve('src/components/primitives/$1'),
      },
      {
        find: /^@pdfjs\/(.*)/,
        replacement: path.resolve('public/vendor/pdfjs/$1'),
      },
      {
        find: /^@simplecc\/(.*)/,
        replacement: path.resolve('public/vendor/simplecc/$1'),
      },
      { find: /^@\/(.*)/, replacement: path.resolve('src/$1') },
      {
        find: 'js-mdict',
        replacement: path.resolve('../../packages/js-mdict/src/index.ts'),
      },
    ],
  },
  build: {
    rollupOptions: {
      external: ['tauri-plugin-turso', 'js-mdict'],
      onwarn(warning, defaultHandler) {
        if (warning.message?.includes("Can't resolve original location of error")) return;
        defaultHandler(warning);
      },
    },
  },
  ssr: {
    noExternal: ['tinycolor2'],
  },
}));
