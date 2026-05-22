import { createStart } from '@tanstack/react-start';
import { corsMiddleware, crossOriginIsolationMiddleware } from './middlewares/cors';

export const startInstance = createStart(() => ({
  requestMiddleware: [corsMiddleware, crossOriginIsolationMiddleware],
}));
