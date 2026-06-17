import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Task 8: two-step stage→finalize upload flow for non-temp book uploads.
 * POST /storage/upload → { stagingKey, uploadUrl }
 * PUT bytes to uploadUrl
 * POST /storage/finalize → { ok: true }
 */

const h = vi.hoisted(() => ({
  webUpload: vi.fn(async () => undefined),
  tauriUpload: vi.fn(async () => undefined),
  fetchWithAuth: vi.fn(),
  isWebAppPlatform: vi.fn(() => true),
}));

vi.mock('@/utils/transfer', () => ({
  webUpload: h.webUpload,
  tauriUpload: h.tauriUpload,
  tauriDownload: vi.fn(),
  webDownload: vi.fn(),
}));
vi.mock('@/services/environment', () => ({
  getAPIBaseUrl: () => 'http://test/api',
  isWebAppPlatform: h.isWebAppPlatform,
}));
vi.mock('@/utils/fetch', () => ({ fetchWithAuth: h.fetchWithAuth }));
vi.mock('@/utils/access', () => ({ getUserID: vi.fn(async () => 'u1') }));

import { uploadFile } from '@/libs/storage';

const jsonResponse = (body: unknown) => ({ json: async () => body }) as Response;

describe('uploadFile — stage→finalize two-step flow (Task 8)', () => {
  afterEach(() => vi.clearAllMocks());

  it('calls upload POST, webUpload, then finalize POST in order', async () => {
    const callOrder: string[] = [];

    h.fetchWithAuth.mockImplementation(async (url: string) => {
      if (url.endsWith('/storage/upload')) {
        callOrder.push('upload-post');
        return jsonResponse({ stagingKey: 'staging/u/x', uploadUrl: 'https://put' });
      }
      if (url.endsWith('/storage/finalize')) {
        callOrder.push('finalize-post');
        return jsonResponse({ ok: true });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    h.webUpload.mockImplementation(async () => {
      callOrder.push('webUpload');
    });

    const file = new File(['content'], 'book.epub', { type: 'application/epub+zip' });
    const result = await uploadFile(file, '/local/book.epub', undefined, 'hash-abc');

    expect(callOrder).toEqual(['upload-post', 'webUpload', 'finalize-post']);
    expect(result).toBeUndefined();
  });

  it('calls finalize POST with correct body', async () => {
    h.fetchWithAuth.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/storage/upload')) {
        return jsonResponse({ stagingKey: 'staging/u/x', uploadUrl: 'https://put' });
      }
      if (url.endsWith('/storage/finalize')) {
        const body = JSON.parse(init?.body as string) as Record<string, unknown>;
        expect(body).toEqual({
          stagingKey: 'staging/u/x',
          fileName: 'book.epub',
          bookHash: 'hash-abc',
          fileSize: 7, // 'content'.length
        });
        return jsonResponse({ ok: true });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const file = new File(['content'], 'book.epub', { type: 'application/epub+zip' });
    await uploadFile(file, '/local/book.epub', undefined, 'hash-abc');
    expect(h.webUpload).toHaveBeenCalledWith(file, 'https://put', undefined);
  });

  it('does NOT call webUpload or finalize when upload POST throws', async () => {
    h.fetchWithAuth.mockImplementation(async (url: string) => {
      if (url.endsWith('/storage/upload')) {
        throw new Error('Network error');
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const file = new File(['content'], 'book.epub');
    await expect(uploadFile(file, '/local/book.epub', undefined, 'hash-abc')).rejects.toThrow(
      'Network error',
    );
    expect(h.webUpload).not.toHaveBeenCalled();
    expect(h.fetchWithAuth).toHaveBeenCalledTimes(1);
  });

  it('uses tauriUpload on non-web platform', async () => {
    h.isWebAppPlatform.mockReturnValue(false);

    h.fetchWithAuth.mockImplementation(async (url: string) => {
      if (url.endsWith('/storage/upload')) {
        return jsonResponse({ stagingKey: 'staging/u/x', uploadUrl: 'https://put' });
      }
      if (url.endsWith('/storage/finalize')) {
        return jsonResponse({ ok: true });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const file = new File(['content'], 'book.epub');
    await uploadFile(file, '/local/book.epub', undefined, 'hash-abc');

    expect(h.tauriUpload).toHaveBeenCalledWith('https://put', '/local/book.epub', 'PUT', undefined);
    expect(h.webUpload).not.toHaveBeenCalled();
  });
});
