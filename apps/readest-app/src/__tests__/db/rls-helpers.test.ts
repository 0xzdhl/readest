import { describe, it, expect, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { withRls, withBypassRls } from '@/db/rls';

const dialect = new PgDialect();
const captured: { sql: string; params: unknown[] }[] = [];

vi.mock('@/db/client', () => ({
  db: {
    transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        execute: async (q: SQL) => {
          const { sql: text, params } = dialect.sqlToQuery(q);
          captured.push({ sql: text, params });
        },
      }),
  },
}));

describe('withRls', () => {
  it('sets app.user_id when userId is provided, parameterized', async () => {
    captured.length = 0;
    await withRls('11111111-1111-1111-1111-111111111111', async () => 'ok');
    expect(captured[0]?.sql).toContain('set_config');
    expect(captured[0]?.sql).toContain('app.user_id');
    expect(captured[0]?.params).toEqual(['11111111-1111-1111-1111-111111111111']);
  });

  it('skips set_config when userId is null', async () => {
    captured.length = 0;
    await withRls(null, async () => 'ok');
    expect(captured.length).toBe(0);
  });
});

describe('withBypassRls', () => {
  it('sets app.bypass_rls=true', async () => {
    captured.length = 0;
    await withBypassRls(async () => 'ok');
    expect(captured[0]?.sql).toContain('app.bypass_rls');
    expect(captured[0]?.sql).toContain("'true'");
  });
});
