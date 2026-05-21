import { describe, it, expect, vi } from 'vitest';
import { withRls, withBypassRls } from '@/db/rls';

const calls: { sql: string; params: unknown[] }[] = [];

vi.mock('@/db/client', () => ({
  db: {
    transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        execute: async (q: { sql: string; params: unknown[] }) => { calls.push(q); },
      }),
  },
}));

describe('withRls', () => {
  it('sets app.user_id when userId is provided', async () => {
    calls.length = 0;
    await withRls('11111111-1111-1111-1111-111111111111', async () => 'ok');
    expect(calls[0]?.sql).toContain('set_config');
    expect(calls[0]?.sql).toContain('app.user_id');
  });
  it('skips set_config when userId is null', async () => {
    calls.length = 0;
    await withRls(null, async () => 'ok');
    expect(calls.length).toBe(0);
  });
});

describe('withBypassRls', () => {
  it('sets app.bypass_rls=true', async () => {
    calls.length = 0;
    await withBypassRls(async () => 'ok');
    expect(calls[0]?.sql).toContain('app.bypass_rls');
  });
});
