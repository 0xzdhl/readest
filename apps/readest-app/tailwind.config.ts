import type { Config } from 'tailwindcss';
import { themes } from './src/styles/themes.ts';
import daisyui from 'daisyui';
import typography from '@tailwindcss/typography';
import plugin from 'tailwindcss/plugin';

const config: Config = {
  // Scan all of src so the JIT engine sees every literally-used class —
  // including utility classes inside HTML strings injected by non-component
  // modules (e.g. the dictionary providers in src/services/dictionaries,
  // which emit `text-lg`, `text-primary`, `text-base-content/60`, ...).
  // This replaces the previous broad `safelist` wildcards that forced the
  // entire color × shade × opacity matrix into the bundle.
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      colors: {
        background: 'var(--background)',
        foreground: 'var(--foreground)',
      },
    },
  },
  plugins: [
    daisyui,
    typography,
    plugin(function ({ addVariant }) {
      addVariant('eink', 'html[data-eink="true"] &');
      addVariant('not-eink', 'html:not([data-eink="true"]) &');
    }),
  ],
  daisyui: {
    themes: themes.reduce(
      (acc, { name, colors }) => {
        acc.push({
          [`${name}-light`]: colors.light,
        });
        acc.push({
          [`${name}-dark`]: colors.dark,
        });
        return acc;
      },
      ['light', 'dark'] as (Record<string, unknown> | string)[],
    ),
  },
};
export default config;
