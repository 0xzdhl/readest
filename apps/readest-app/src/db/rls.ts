import { sql } from 'drizzle-orm';
import { db } from './client';

type TxLike = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function withRls<T>(
  userId: string | null,
  fn: (tx: TxLike) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    if (userId) {
      await tx.execute(sql`SELECT set_config('app.user_id', ${userId}, true)`);
    }
    return fn(tx);
  });
}

export async function withBypassRls<T>(
  fn: (tx: TxLike) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.bypass_rls', 'true', true)`);
    return fn(tx);
  });
}
