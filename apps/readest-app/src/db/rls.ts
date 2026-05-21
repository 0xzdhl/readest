import { sql } from 'drizzle-orm';
import { db } from './client';

type TxLike = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Run `fn` inside a transaction with `app.user_id` set so the per-table RLS
 * policies in `0001_rls_and_pg_funcs.sql` allow access to the caller's rows.
 *
 * Fail-closed semantics: when `userId` is `null`, no `set_config` is issued
 * and `app.user_id` reads back as the empty string. Every policy compares
 * `user_id = current_setting('app.user_id', true)` against actual user_id
 * values (always non-empty), so unauthenticated callers see no rows and
 * cannot insert/update/delete.
 *
 * Nested-call constraint: do NOT nest `withRls` / `withBypassRls` calls on
 * the same connection. `set_config(..., true)` is transaction-scoped, so an
 * inner call's value persists for the rest of the outer transaction
 * (including after the inner promise resolves). If you need a sub-scope,
 * pass the `tx` parameter through rather than re-entering.
 */
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

/**
 * Run `fn` inside a transaction with `app.bypass_rls = 'true'`, which the
 * RLS policies in `0001_rls_and_pg_funcs.sql` recognise as a service-role
 * escape hatch. Use only from trusted server code (webhooks, cron jobs,
 * admin operations) — never with a user-supplied identifier.
 *
 * Same nested-call constraint as `withRls`: the bypass setting is
 * transaction-scoped and an inner overwrite is permanent for the remainder
 * of the outer transaction.
 */
export async function withBypassRls<T>(
  fn: (tx: TxLike) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.bypass_rls', 'true', true)`);
    return fn(tx);
  });
}
