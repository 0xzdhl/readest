import { createMiddleware } from '@tanstack/react-start';

/**
 * Initialize drizzle-orm
 */
export const databaseMiddleware = createMiddleware().server(async ({ next, request }) => {
  return next();
});
