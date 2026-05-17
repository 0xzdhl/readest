import { createRootRoute, HeadContent, Outlet, Scripts } from '@tanstack/react-router';
import Providers from '@/components/Providers';
import { EnvProvider } from '@/context/EnvContext';
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
      { title: 'Readest' },
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
        <EnvProvider>
          <Providers>
            <Outlet />
            <Scripts />
          </Providers>
        </EnvProvider>
      </body>
    </html>
  );
}
