import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runRoute } from '../utils/run-route';

/**
 * Consolidated tests for routes that compose `protectedMiddleware` (no DB tx,
 * just session resolution):
 *
 *   - /api/ai/chat               (POST)
 *   - /api/ai/embed              (POST)
 *   - /api/metadata/search       (POST)
 *   - /api/tts/edge              (GET + POST)
 *   - /api/deepl/translate       (POST)
 *
 * The 401 path exercises the middleware chain end-to-end: missing session
 * → `{ error: 'Not authenticated' }` JSON, which `useSync.ts` substring-
 * matches to trigger silent re-login. The 200 path verifies the handler
 * still works once the middleware has populated `context.user`.
 */

const getSessionMock = vi.hoisted(() => vi.fn());

vi.mock('@/auth/server', () => ({
  createAuth: () => ({ api: { getSession: getSessionMock } }),
}));

vi.mock('@/db/client', () => ({
  createDbClient: () => ({}),
}));

vi.mock('ai', () => ({
  streamText: vi.fn(() => ({
    toTextStreamResponse: () => new Response('hello', { status: 200 }),
  })),
  embed: vi.fn(async () => ({ embedding: [0.1, 0.2] })),
  embedMany: vi.fn(async () => ({ embeddings: [[0.1], [0.2]] })),
  createGateway: vi.fn(() => {
    const gateway = (_model: string) => ({});
    gateway.embeddingModel = (_m: string) => ({});
    return gateway;
  }),
}));

vi.mock('@/services/metadata/service', () => ({
  MetadataService: class {
    async search() {
      return { title: 'Found', author: 'Author' };
    }
  },
}));

vi.mock('@/libs/edgeTTS', () => ({
  EdgeSpeechTTS: class {
    static voices = [
      { id: 'en-US-AriaNeural', name: 'Aria', lang: 'en-US' },
      { id: 'fr-FR-DeniseNeural', name: 'Denise', lang: 'fr-FR' },
    ];
    async create() {
      return new Response(new Uint8Array([1, 2, 3]).buffer, { status: 200 });
    }
  },
}));

const sessionFor = (overrides: Record<string, unknown> = {}) => ({
  user: {
    id: '11111111-1111-1111-1111-111111111111',
    email: 'a@test.example',
    emailVerified: true,
    name: 'Test',
    plan: 'free',
    storageUsageBytes: 0,
    storagePurchasedBytes: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  },
  session: {
    id: 's',
    userId: '11111111-1111-1111-1111-111111111111',
    token: 't',
    expiresAt: new Date(),
  },
});

beforeEach(() => {
  getSessionMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

type RouteModule = { Route: Parameters<typeof runRoute>[0] };

describe('/api/ai/chat (protectedMiddleware)', () => {
  it('401 JSON when no session', { timeout: 30_000 }, async () => {
    getSessionMock.mockResolvedValueOnce(null);
    const mod = (await import('@/app/api/ai/chat/route')) as RouteModule;
    const request = new Request('http://localhost/api/ai/chat', {
      method: 'POST',
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });
    const response = await runRoute(mod.Route, 'POST', { request });
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toBe('Not authenticated');
  });

  it('200 when session exists and apiKey supplied', { timeout: 30_000 }, async () => {
    getSessionMock.mockResolvedValueOnce(sessionFor());
    const mod = (await import('@/app/api/ai/chat/route')) as RouteModule;
    const request = new Request('http://localhost/api/ai/chat', {
      method: 'POST',
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'hi' }],
        apiKey: 'test-key',
      }),
    });
    const response = await runRoute(mod.Route, 'POST', { request });
    expect(response.status).toBe(200);
  });
});

describe('/api/ai/embed (protectedMiddleware)', () => {
  it('401 JSON when no session', { timeout: 30_000 }, async () => {
    getSessionMock.mockResolvedValueOnce(null);
    const mod = (await import('@/app/api/ai/embed/route')) as RouteModule;
    const request = new Request('http://localhost/api/ai/embed', {
      method: 'POST',
      body: JSON.stringify({ texts: ['hello'] }),
    });
    const response = await runRoute(mod.Route, 'POST', { request });
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toBe('Not authenticated');
  });

  it('200 with embedding when session exists', async () => {
    getSessionMock.mockResolvedValueOnce(sessionFor());
    const mod = (await import('@/app/api/ai/embed/route')) as RouteModule;
    const request = new Request('http://localhost/api/ai/embed', {
      method: 'POST',
      body: JSON.stringify({ texts: ['hello'], single: true, apiKey: 'test-key' }),
    });
    const response = await runRoute(mod.Route, 'POST', { request });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { embedding?: number[] };
    expect(Array.isArray(body.embedding)).toBe(true);
  });
});

describe('/api/metadata/search (protectedMiddleware)', () => {
  it('401 JSON when no session', { timeout: 30_000 }, async () => {
    getSessionMock.mockResolvedValueOnce(null);
    const mod = (await import('@/app/api/metadata/search/route')) as RouteModule;
    const request = new Request('http://localhost/api/metadata/search', {
      method: 'POST',
      body: JSON.stringify({ title: 'The Hobbit' }),
    });
    const response = await runRoute(mod.Route, 'POST', { request });
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toBe('Not authenticated');
  });

  it('200 with result when session exists', async () => {
    getSessionMock.mockResolvedValueOnce(sessionFor());
    const mod = (await import('@/app/api/metadata/search/route')) as RouteModule;
    const request = new Request('http://localhost/api/metadata/search', {
      method: 'POST',
      body: JSON.stringify({ title: 'The Hobbit' }),
    });
    const response = await runRoute(mod.Route, 'POST', { request });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { success: boolean; data?: { title: string } };
    expect(body.success).toBe(true);
    expect(body.data?.title).toBe('Found');
  });
});

describe('/api/tts/edge (protectedMiddleware)', () => {
  it('POST 401 JSON when no session', async () => {
    getSessionMock.mockResolvedValueOnce(null);
    const mod = (await import('@/app/api/tts/edge/route')) as RouteModule;
    const request = new Request('http://localhost/api/tts/edge', {
      method: 'POST',
      body: JSON.stringify({ input: 'hello', voice: 'en-US-AriaNeural', speed: 1.0 }),
    });
    const response = await runRoute(mod.Route, 'POST', { request });
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toBe('Not authenticated');
  });

  it('GET 401 JSON when no session', async () => {
    getSessionMock.mockResolvedValueOnce(null);
    const mod = (await import('@/app/api/tts/edge/route')) as RouteModule;
    const request = new Request('http://localhost/api/tts/edge', { method: 'GET' });
    const response = await runRoute(mod.Route, 'GET', { request });
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toBe('Not authenticated');
  });

  it('GET 200 lists voices when session exists', async () => {
    getSessionMock.mockResolvedValueOnce(sessionFor());
    const mod = (await import('@/app/api/tts/edge/route')) as RouteModule;
    const request = new Request('http://localhost/api/tts/edge', { method: 'GET' });
    const response = await runRoute(mod.Route, 'GET', { request });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { voices: Array<{ id: string }> };
    expect(body.voices.length).toBeGreaterThan(0);
  });

  it('POST 200 returns audio bytes when session exists', async () => {
    getSessionMock.mockResolvedValueOnce(sessionFor());
    const mod = (await import('@/app/api/tts/edge/route')) as RouteModule;
    const request = new Request('http://localhost/api/tts/edge', {
      method: 'POST',
      body: JSON.stringify({ input: 'hi', voice: 'en-US-AriaNeural', speed: 1.0 }),
    });
    const response = await runRoute(mod.Route, 'POST', { request });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('audio/mpeg');
  });
});

describe('/api/deepl/translate (protectedMiddleware)', () => {
  it('401 JSON when no session', { timeout: 30_000 }, async () => {
    getSessionMock.mockResolvedValueOnce(null);
    const mod = (await import('@/app/api/deepl/translate')) as RouteModule;
    const request = new Request('http://localhost/api/deepl/translate', {
      method: 'POST',
      body: JSON.stringify({ text: ['hello'], source_lang: 'EN', target_lang: 'FR' }),
    });
    const response = await runRoute(mod.Route, 'POST', { request });
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toBe('Not authenticated');
  });

  it('200 with translation when session exists (mocked deepl fetch)', { timeout: 30_000 }, async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        translations: [{ text: 'bonjour', detected_source_language: 'EN' }],
      }),
    });
    vi.stubGlobal('fetch', fetchSpy);

    getSessionMock.mockResolvedValueOnce(sessionFor());
    const mod = (await import('@/app/api/deepl/translate')) as RouteModule;
    const request = new Request('http://localhost/api/deepl/translate', {
      method: 'POST',
      body: JSON.stringify({ text: ['hello'], source_lang: 'EN', target_lang: 'FR' }),
    });
    const response = await runRoute(mod.Route, 'POST', { request });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      translations: Array<{ text: string }>;
    };
    expect(body.translations[0]?.text).toBe('bonjour');
    expect(fetchSpy).toHaveBeenCalled();
  });
});
