import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '@/env';
import * as schema from './schema';

const queryClient = postgres(env.DATABASE_URL, {
  prepare: false,
  max: env.DATABASE_POOL_MAX,
  idle_timeout: 20,
});
export const db = drizzle(queryClient, { schema });
export type DbClient = typeof db;
