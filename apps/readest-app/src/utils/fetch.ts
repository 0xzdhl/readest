import { getAccessToken } from './access';

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

export const fetchWithAuth = async (url: string, options: RequestInit) => {
  const token = await getAccessToken();
  if (!token) {
    throw new Error('Not authenticated');
  }
  const headers = {
    ...options.headers,
    Authorization: `Bearer ${token}`,
  };

  const response = await fetch(url, { ...options, headers });

  if (!response.ok) {
    const errorData = await response.json();
    const errorMessage = getErrorMessage(errorData, response.statusText || 'Request failed');
    console.error('Error:', errorMessage);
    throw new Error(errorMessage);
  }

  return response;
};
