import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * #13: when the server reports the object already exists (`skipUpload: true`),
 * the client must NOT re-transmit the binary. When it returns an `uploadUrl`,
 * the client uploads as usual.
 */

const h = vi.hoisted(() => ({
  webUpload: vi.fn(async () => undefined),
  tauriUpload: vi.fn(async () => undefined),
  fetchWithAuth: vi.fn(),
}));
const { webUpload, tauriUpload, fetchWithAuth } = h;

vi.mock('@/utils/transfer', () => ({
  webUpload: h.webUpload,
  tauriUpload: h.tauriUpload,
  tauriDownload: vi.fn(),
  webDownload: vi.fn(),
}));
vi.mock('@/services/environment', () => ({
  getAPIBaseUrl: () => 'http://test/api',
  isWebAppPlatform: () => true,
}));
vi.mock('@/utils/fetch', () => ({ fetchWithAuth: h.fetchWithAuth }));
vi.mock('@/utils/access', () => ({ getUserID: vi.fn(async () => 'u1') }));

import { uploadFile } from '@/libs/storage';

const jsonResponse = (body: unknown) => ({ json: async () => body }) as Response;

describe('uploadFile — skip re-transmit when object exists (#13)', () => {
  afterEach(() => vi.clearAllMocks());

  it('does NOT PUT when the server returns skipUpload', async () => {
    fetchWithAuth.mockResolvedValue(jsonResponse({ skipUpload: true, fileKey: 'u1/h/h.epub' }));
    const file = new File(['x'], 'h.epub');
    await uploadFile(file, '/local/h.epub', undefined, 'h');
    expect(webUpload).not.toHaveBeenCalled();
    expect(tauriUpload).not.toHaveBeenCalled();
  });

  it('PUTs the file when the server returns an uploadUrl', async () => {
    fetchWithAuth.mockResolvedValue(jsonResponse({ uploadUrl: 'http://signed/put' }));
    const file = new File(['x'], 'h.epub');
    await uploadFile(file, '/local/h.epub', undefined, 'h');
    expect(webUpload).toHaveBeenCalledTimes(1);
    expect(webUpload).toHaveBeenCalledWith(file, 'http://signed/put', undefined);
  });
});
