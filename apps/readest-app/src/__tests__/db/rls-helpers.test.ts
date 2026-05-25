import { describe, expect, it } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { setRlsBypass, setRlsUserId } from '@/db/rls';

const dialect = new PgDialect();

const makeFakeTx = () => {
  const captured: { sql: string; params: unknown[] }[] = [];
  return {
    captured,
    tx: {
      execute: async (q: SQL) => {
        const { sql: text, params } = dialect.sqlToQuery(q);
        captured.push({ sql: text, params });
      },
    },
  };
};

describe('setRlsUserId', () => {
  it('issues set_config(app.user_id, $1) with parameterized userId', async () => {
    const { tx, captured } = makeFakeTx();
    await setRlsUserId(
      tx as unknown as Parameters<typeof setRlsUserId>[0],
      '11111111-1111-1111-1111-111111111111',
    );
    expect(captured).toHaveLength(1);
    expect(captured[0]?.sql).toContain('set_config');
    expect(captured[0]?.sql).toContain('app.user_id');
    expect(captured[0]?.params).toEqual(['11111111-1111-1111-1111-111111111111']);
  });

  it('does not interpolate the userId into the SQL string', async () => {
    const { tx, captured } = makeFakeTx();
    await setRlsUserId(
      tx as unknown as Parameters<typeof setRlsUserId>[0],
      "'; DROP TABLE users; --",
    );
    expect(captured[0]?.sql).not.toContain('DROP');
    expect(captured[0]?.params?.[0]).toBe("'; DROP TABLE users; --");
  });
});

describe('setRlsBypass', () => {
  it('issues set_config(app.bypass_rls, true)', async () => {
    const { tx, captured } = makeFakeTx();
    await setRlsBypass(tx as unknown as Parameters<typeof setRlsBypass>[0]);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.sql).toContain('app.bypass_rls');
    expect(captured[0]?.sql).toContain("'true'");
  });
});
