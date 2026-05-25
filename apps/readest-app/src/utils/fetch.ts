import { isTauriAppPlatform } from '@/services/environment';
import { buildSessionCookieHeader } from '@/auth';
import { getNativeSessionToken } from './access';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const getErrorMessage = (data: unknown, fallback: string) => {
  if (isRecord(data) && typeof data['error'] === 'string') {
    return data['error'];
  }
  return fallback;
};

export const fetchWithTimeout = (url: string, options: RequestInit = {}, timeout = 10000) => {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort('Request timed out'), timeout);

  return fetch(url, {
    ...options,
    signal: controller.signal,
  }).finally(() => clearTimeout(id));
};

export const buildAuthFetchOptions = async (options: RequestInit = {}): Promise<RequestInit> => {
  const token = await getNativeSessionToken();
  const headers = new Headers(options.headers);
  headers.delete('Authorization');
  if (token) {
    const cookieHeader = buildSessionCookieHeader(token);
    return {
      ...options,
      credentials: 'omit',
      headers: cookieHeader
        ? (() => {
            headers.set('Cookie', cookieHeader);
            return headers;
          })()
        : headers,
    };
  }
  if (isTauriAppPlatform()) {
    throw new Error('Not authenticated');
  }
  return {
    ...options,
    headers,
    credentials: options.credentials ?? 'include',
  };
};

export const fetchWithAuth = async (url: string, options: RequestInit) => {
  const response = await fetch(url, await buildAuthFetchOptions(options));

  if (!response.ok) {
    const errorData = await response.json();
    const errorMessage = getErrorMessage(errorData, response.statusText || 'Request failed');
    console.error('Error:', errorMessage);
    throw new Error(errorMessage);
  }

  return response;
};
