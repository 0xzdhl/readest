import { sql } from 'drizzle-orm';
import { db } from './client';

type TxLike = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Build a query object that satisfies both the drizzle execute interface
 *  (which calls `.getSQL()` on the argument) and the test mock (which checks
 *  `q.sql` directly as a string).
 */
function rlsQuery(sqlStr: string, params: unknown[] = []) {
  return {
    sql: sqlStr,
    params,
    getSQL() {
      return sql.raw(sqlStr);
    },
  };
}

export async function withRls<T>(
  userId: string | null,
  fn: (tx: TxLike) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    if (userId) {
      await tx.execute(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        rlsQuery(`SELECT set_config('app.user_id', '${userId}', true)`) as any,
      );
    }
    return fn(tx);
  });
}

export async function withBypassRls<T>(
  fn: (tx: TxLike) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      rlsQuery(`SELECT set_config('app.bypass_rls', 'true', true)`) as any,
    );
    return fn(tx);
  });
}
