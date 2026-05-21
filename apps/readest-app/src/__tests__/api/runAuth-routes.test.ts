import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Phase 8 — consolidated tests for the routes refactored from
 * `validateUserAndToken` to the lightweight `runAuth` wrapper:
 *
 *   - /api/ai/chat               (POST)
 *   - /api/ai/embed              (POST)
 *   - /api/metadata/search       (POST)
 *   - /api/tts/edge              (GET + POST)
 *   - /api/deepl/translate       (POST)
 *
 * These routes don't open a DB transaction — they only need to identify the
 * caller (for plan/quota gating against `session.user`). The tests cover one
 * happy path + one 401 per route, exercising the wire-format contract
 * (`{ error: 'Not authenticated' }` JSON) that the client substring-matches
 * to trigger re-auth.
 */

const getSessionMock = vi.hoisted(() => vi.fn());
vi.mock('@/auth/server', () => ({
  auth: { api: { getSession: getSessionMock } },
}));

// Stub `@/db/client` so importing `route-helpers` (which transitively pulls
// in withRls → @/db/client) doesn't try to open a real Postgres connection
// at module-load time. None of the runAuth routes actually use the db
// handle, but the import chain would otherwise throw "DATABASE_URL is not
// set" before the test even starts.
vi.mock('@/db/client', () => ({
  db: { transaction: vi.fn() },
}));
vi.mock('@/db/rls', () => ({
  withRls: vi.fn(),
  withBypassRls: vi.fn(),
}));

// Each route's third-party dependency is stubbed so the test never makes a
// real network call. The route's own auth-then-body flow is what we're
// pinning; the downstream provider's behaviour has its own tests.
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

// DeepL pulls in @/utils/access (which reads env at module load) and ai's
// gateway constructor — both already stubbed above. The fetch the route
// makes to the real DeepL URL is stubbed per-test.

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

interface RouteShape {
  options: {
    server: {
      handlers: {
        GET?: (args: { request: Request }) => Promise<Response>;
        POST?: (args: { request: Request }) => Promise<Response>;
      };
    };
  };
}

beforeEach(() => {
  getSessionMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('/api/ai/chat (runAuth)', () => {
  it('401 JSON when no session', async () => {
    getSessionMock.mockResolvedValueOnce(null);
    const mod = await import('@/app/api/ai/chat/route');
    const post = (mod.Route as unknown as RouteShape).options.server.handlers.POST!;
    const request = new Request('http://localhost/api/ai/chat', {
      method: 'POST',
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });
    const response = await post({ request });
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toBe('Not authenticated');
  });

  it('200 when session exists and apiKey supplied', async () => {
    getSessionMock.mockResolvedValueOnce(sessionFor());
    const mod = await import('@/app/api/ai/chat/route');
    const post = (mod.Route as unknown as RouteShape).options.server.handlers.POST!;
    const request = new Request('http://localhost/api/ai/chat', {
      method: 'POST',
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'hi' }],
        apiKey: 'test-key',
      }),
    });
    const response = await post({ request });
    expect(response.status).toBe(200);
  });
});

describe('/api/ai/embed (runAuth)', () => {
  it('401 JSON when no session', async () => {
    getSessionMock.mockResolvedValueOnce(null);
    const mod = await import('@/app/api/ai/embed/route');
    const post = (mod.Route as unknown as RouteShape).options.server.handlers.POST!;
    const request = new Request('http://localhost/api/ai/embed', {
      method: 'POST',
      body: JSON.stringify({ texts: ['hello'] }),
    });
    const response = await post({ request });
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toBe('Not authenticated');
  });

  it('200 with embedding when session exists', async () => {
    getSessionMock.mockResolvedValueOnce(sessionFor());
    const mod = await import('@/app/api/ai/embed/route');
    const post = (mod.Route as unknown as RouteShape).options.server.handlers.POST!;
    const request = new Request('http://localhost/api/ai/embed', {
      method: 'POST',
      body: JSON.stringify({ texts: ['hello'], single: true, apiKey: 'test-key' }),
    });
    const response = await post({ request });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { embedding?: number[] };
    expect(Array.isArray(body.embedding)).toBe(true);
  });
});

describe('/api/metadata/search (runAuth)', () => {
  it('401 JSON when no session', async () => {
    getSessionMock.mockResolvedValueOnce(null);
    const mod = await import('@/app/api/metadata/search/route');
    const post = (mod.Route as unknown as RouteShape).options.server.handlers.POST!;
    const request = new Request('http://localhost/api/metadata/search', {
      method: 'POST',
      body: JSON.stringify({ title: 'The Hobbit' }),
    });
    const response = await post({ request });
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toBe('Not authenticated');
  });

  it('200 with result when session exists', async () => {
    getSessionMock.mockResolvedValueOnce(sessionFor());
    const mod = await import('@/app/api/metadata/search/route');
    const post = (mod.Route as unknown as RouteShape).options.server.handlers.POST!;
    const request = new Request('http://localhost/api/metadata/search', {
      method: 'POST',
      body: JSON.stringify({ title: 'The Hobbit' }),
    });
    const response = await post({ request });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { success: boolean; data?: { title: string } };
    expect(body.success).toBe(true);
    expect(body.data?.title).toBe('Found');
  });
});

describe('/api/tts/edge (runAuth)', () => {
  it('POST 401 JSON when no session', async () => {
    getSessionMock.mockResolvedValueOnce(null);
    const mod = await import('@/app/api/tts/edge/route');
    const post = (mod.Route as unknown as RouteShape).options.server.handlers.POST!;
    const request = new Request('http://localhost/api/tts/edge', {
      method: 'POST',
      body: JSON.stringify({ input: 'hello', voice: 'en-US-AriaNeural', speed: 1.0 }),
    });
    const response = await post({ request });
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toBe('Not authenticated');
  });

  it('GET 401 JSON when no session', async () => {
    getSessionMock.mockResolvedValueOnce(null);
    const mod = await import('@/app/api/tts/edge/route');
    const get = (mod.Route as unknown as RouteShape).options.server.handlers.GET!;
    const request = new Request('http://localhost/api/tts/edge', { method: 'GET' });
    const response = await get({ request });
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toBe('Not authenticated');
  });

  it('GET 200 lists voices when session exists', async () => {
    getSessionMock.mockResolvedValueOnce(sessionFor());
    const mod = await import('@/app/api/tts/edge/route');
    const get = (mod.Route as unknown as RouteShape).options.server.handlers.GET!;
    const request = new Request('http://localhost/api/tts/edge', { method: 'GET' });
    const response = await get({ request });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { voices: Array<{ id: string }> };
    expect(body.voices.length).toBeGreaterThan(0);
  });

  it('POST 200 returns audio bytes when session exists', async () => {
    getSessionMock.mockResolvedValueOnce(sessionFor());
    const mod = await import('@/app/api/tts/edge/route');
    const post = (mod.Route as unknown as RouteShape).options.server.handlers.POST!;
    const request = new Request('http://localhost/api/tts/edge', {
      method: 'POST',
      body: JSON.stringify({ input: 'hi', voice: 'en-US-AriaNeural', speed: 1.0 }),
    });
    const response = await post({ request });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('audio/mpeg');
  });
});

describe('/api/deepl/translate (runAuth)', () => {
  it('401 JSON when no session', async () => {
    getSessionMock.mockResolvedValueOnce(null);
    const mod = await import('@/app/api/deepl/translate');
    const post = (mod.Route as unknown as RouteShape).options.server.handlers.POST!;
    const request = new Request('http://localhost/api/deepl/translate', {
      method: 'POST',
      body: JSON.stringify({ text: ['hello'], source_lang: 'EN', target_lang: 'FR' }),
    });
    const response = await post({ request });
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toBe('Not authenticated');
  });

  it('200 with translation when session exists (mocked deepl fetch)', async () => {
    // Stub global fetch for the DeepL upstream call. The route uses
    // node's `fetch` global so vi.stubGlobal works.
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        translations: [{ text: 'bonjour', detected_source_language: 'EN' }],
      }),
    });
    vi.stubGlobal('fetch', fetchSpy);

    getSessionMock.mockResolvedValueOnce(sessionFor());
    const mod = await import('@/app/api/deepl/translate');
    const post = (mod.Route as unknown as RouteShape).options.server.handlers.POST!;
    const request = new Request('http://localhost/api/deepl/translate', {
      method: 'POST',
      body: JSON.stringify({ text: ['hello'], source_lang: 'EN', target_lang: 'FR' }),
    });
    const response = await post({ request });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      translations: Array<{ text: string }>;
    };
    expect(body.translations[0]?.text).toBe('bonjour');
    expect(fetchSpy).toHaveBeenCalled();
  });
});
