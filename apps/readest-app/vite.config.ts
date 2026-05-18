import path from 'node:path';
import { cloudflare } from '@cloudflare/vite-plugin';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig(() => ({
  plugins: [
    tanstackStart({
      srcDirectory: './src',
      router: {
        routesDirectory: 'app',
        routeFileIgnorePattern:
          '(components|utils|hooks|services|context|store|types|helpers|libs)|ShareLanding.tsx|SharePage.tsx|shareRoute.ts|OpenAnnotationPage.tsx|ReaderContent.tsx|ReaderRoutePage.tsx|readerSearch.ts|not-found.tsx|render.tsx',
        // Bundle all UI components (component, pending, error, notFound) for a
        // route into one chunk separate from the route definition + loader.
        // Reduces the per-route waterfall and shrinks the eager route shell.
        codeSplittingOptions: {
          defaultBehavior: [
            ['component', 'pendingComponent', 'errorComponent', 'notFoundComponent'],
          ],
        },
      },
    }),
    viteReact(),
    cloudflare({ viteEnvironment: { name: 'ssr' } }),
  ],
  resolve: {
    tsconfigPaths: true,
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
  optimizeDeps: {
    include: ['react', 'react-dom', 'fflate'],
  },
}));
