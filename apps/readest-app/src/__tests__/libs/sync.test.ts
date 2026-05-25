import { beforeEach, describe, expect, test, vi } from 'vitest';

const getNativeSessionTokenMock = vi.fn();
var isTauri = false;
const mockFetch = vi.fn();

vi.mock('@/utils/access', () => ({
  getNativeSessionToken: () => getNativeSessionTokenMock(),
}));

vi.mock('@/services/environment', () => ({
  getAPIBaseUrl: () => 'https://example.test',
  isTauriAppPlatform: () => isTauri,
}));

vi.mock('@/utils/unknown', () => ({
  getJsonErrorMessage: (value: unknown) =>
    typeof value === 'object' && value !== null && 'error' in value
      ? String((value as { error?: string }).error)
      : null,
}));

import { SyncClient } from '@/libs/sync';

beforeEach(() => {
  isTauri = false;
  getNativeSessionTokenMock.mockReset();
  mockFetch.mockReset();
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});

describe('SyncClient', () => {
  test('web pullChanges falls back to cookie auth when no native session token exists', async () => {
    getNativeSessionTokenMock.mockResolvedValueOnce(null);
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ books: [], configs: [], notes: [] }), { status: 200 }),
    );

    const client = new SyncClient();
    await client.pullChanges(0, 'books');

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toContain('/sync?since=0&type=books');
    expect(init.headers?.Authorization).toBeUndefined();
    expect(init.credentials).toBe('include');
  });

  test('native pullChanges still throws when no native session token exists', async () => {
    isTauri = true;
    getNativeSessionTokenMock.mockResolvedValueOnce(null);

    const client = new SyncClient();
    await expect(client.pullChanges(0, 'books')).rejects.toThrow('Not authenticated');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
