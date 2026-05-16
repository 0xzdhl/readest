import path from 'node:path';
import { defineConfig } from 'vite';
import viteReact from '@vitejs/plugin-react-swc';
import { cloudflare } from '@cloudflare/vite-plugin';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [
    tailwindcss(),
    tanstackStart({
      srcDirectory: './src',
      router: {
        routesDirectory: 'app',
      },
    }),
    viteReact(),

    cloudflare({ viteEnvironment: { name: 'ssr' } }),
  ],
  resolve: {
    alias: {
      '@pdfjs': path.resolve('public/vendor/pdfjs'),
      '@simplecc': path.resolve('public/vendor/simplecc'),
    },
  },
  build: {
    rollupOptions: {
      onwarn(warning, defaultHandler) {
        if (warning.message?.includes("Can't resolve original location of error")) return;
        defaultHandler(warning);
      },
    },
  },
  ssr: {
    noExternal: ['tinycolor2'],
  },
});
