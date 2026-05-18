import { createRouter } from '@tanstack/react-router';
import { DefaultRouterErrorComponent } from '@/app/error';
import { routeTree } from './routeTree.gen';

export function getRouter() {
  const router = createRouter({
    routeTree,
    scrollRestoration: true,
    defaultPreload: 'intent',
    defaultPreloadStaleTime: 0,
    defaultErrorComponent: DefaultRouterErrorComponent,
  });

  return router;
}

export type AppRouter = ReturnType<typeof getRouter>;
