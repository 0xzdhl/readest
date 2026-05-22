import { createMiddleware } from '@tanstack/react-start';

const allowedOrigins = [
  'https://web.readest.com',
  'https://tauri.localhost',
  'http://tauri.localhost',
  'http://localhost:3000',
  'http://localhost:3001',
  'tauri://localhost',
];

const corsOptions = {
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Max-Age': '86400',
};

export const corsMiddleware = createMiddleware().server(async ({ next, request }) => {
  const isApi = new URL(request.url).pathname.startsWith('/api/');

  if (isApi) {
    const origin = request.headers.get('origin') ?? '';
    const isAllowedOrigin = allowedOrigins.includes(origin);

    if (request.method === 'OPTIONS') {
      const preflightHeaders = new Headers(corsOptions);
      if (isAllowedOrigin) {
        preflightHeaders.set('Access-Control-Allow-Origin', origin);
      }
      return new Response(null, { status: 200, headers: preflightHeaders });
    }

    const result = await next();

    if (isAllowedOrigin) {
      result.response.headers.set('Access-Control-Allow-Origin', origin);
    }

    for (const [key, value] of Object.entries(corsOptions)) {
      result.response.headers.set(key, value);
    }

    return result;
  }

  return next();
});

export const crossOriginIsolationMiddleware = createMiddleware().server(async ({ next }) => {
  const result = await next();
  result.response.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  result.response.headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  return result;
});
