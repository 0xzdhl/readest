// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';
import { runRoute } from '../utils/run-route';

/**
 * `/api/auth-config` is a public, unauthenticated endpoint the login screen
 * fetches to learn which OAuth providers are configured on the server. It
 * simply surfaces `enabledSocialProviders` from the auth server module.
 */

vi.mock('@/auth/server', () => ({
  enabledSocialProviders: ['google', 'discord'],
  signupEnabled: false,
}));

type RouteModule = { Route: Parameters<typeof runRoute>[0] };

afterEach(() => {
  vi.restoreAllMocks();
});

describe('/api/auth-config', () => {
  it('GET returns the enabled social providers and the signup toggle', async () => {
    const mod = (await import('@/app/api/auth-config')) as RouteModule;
    const request = new Request('http://localhost/api/auth-config', { method: 'GET' });
    const response = await runRoute(mod.Route, 'GET', { request });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { providers: string[]; signupEnabled: boolean };
    expect(body.providers).toEqual(['google', 'discord']);
    expect(body.signupEnabled).toBe(false);
  });
});
