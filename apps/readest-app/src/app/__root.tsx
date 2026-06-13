import { createRootRoute, HeadContent, Outlet, Scripts } from '@tanstack/react-router';
import Providers from '@/components/Providers';
import { EffectRuntimeProvider } from '@/context/EffectRuntimeProvider';
import { isTauriAppPlatform } from '@/services/environment';
import { NotFoundPage } from '@/app/not-found';
import appCss from '@/styles/globals.css?url';

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      {
        name: 'viewport',
        content: 'width=device-width, initial-scale=1',
      },
      { title: 'Readen' },
    ],
    links: [
      {
        rel: 'stylesheet',
        href: appCss,
      },
    ],
  }),
  notFoundComponent: NotFoundPage,
  component: RootLayout,
});

function RootLayout() {
  return (
    <html lang='en' className={isTauriAppPlatform() ? 'edge-to-edge' : ''}>
      <head>
        <HeadContent />
      </head>
      <body>
        <EffectRuntimeProvider>
          <Providers>
            <Outlet />
            <Scripts />
          </Providers>
        </EffectRuntimeProvider>
      </body>
    </html>
  );
}
