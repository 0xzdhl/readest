import { sql } from 'drizzle-orm';
import type { DbClient } from './client';

export type DbTx = Parameters<Parameters<DbClient['transaction']>[0]>[0];

// Pure functions to perform RLS operations
export async function setRlsUserId(tx: DbTx, userId: string): Promise<void> {
  await tx.execute(sql`SELECT set_config('app.user_id', ${userId}, true)`);
}

export async function setRlsBypass(tx: DbTx): Promise<void> {
  await tx.execute(sql`SELECT set_config('app.bypass_rls', 'true', true)`);
}
