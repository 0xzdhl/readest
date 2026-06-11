import { describe, it, expect, vi } from 'vitest';

// Capture the createFileRoute id + config the same way the auth route tests do,
// so we can assert the share route is registered at the PATH-based id and loads
// its token from the path param (not a ?token= search param).
vi.mock('@tanstack/react-router', () => ({
  createFileRoute: (id: string) => (cfg: Record<string, unknown>) => ({ id, ...cfg }),
}));

const loadSharePageMock = vi.fn(async (token: string) => ({ token }));
vi.mock('@/app/s/shareRoute', () => ({
  loadSharePage: (token: string) => loadSharePageMock(token),
  buildShareHead: () => ({ title: 'shared' }),
}));
vi.mock('@/app/s/SharePage', () => ({ SharePage: () => null }));

import { Route } from '@/app/s/$token';

interface CapturedRoute {
  id: string;
  loader: (ctx: { params: { token: string } }) => Promise<unknown>;
}

const route = Route as unknown as CapturedRoute;

describe('/s/$token route', () => {
  it('is registered at the path-based id so /s/{token} links resolve', () => {
    // The share URL shape is `${base}/s/{token}` (see buildShareUrl). Without a
    // `/s/$token` route the path falls through to not-found ("That page is not
    // available"). This guards against that regression.
    expect(route.id).toBe('/s/$token');
  });

  it('loads the share using the token from the path param', async () => {
    const token = 'aBcDeFgHiJkLmNoPqRsTuV';
    await route.loader({ params: { token } });
    expect(loadSharePageMock).toHaveBeenCalledWith(token);
  });
});
