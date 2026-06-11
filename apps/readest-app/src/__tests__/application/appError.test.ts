import { describe, expect, it } from 'vitest';
import { FsError, UserCancelled, type AppError } from '@/application/errors/AppError';

describe('AppError taxonomy', () => {
  it('FsError carries operation/path/cause and a discriminant tag', () => {
    const err = new FsError({ operation: 'readFile', path: '/x', cause: new Error('boom') });
    expect(err._tag).toBe('FsError');
    expect(err.operation).toBe('readFile');
    expect(err.path).toBe('/x');
  });

  it('UserCancelled is part of the AppError union and discriminates by _tag', () => {
    const e: AppError = new UserCancelled({ operation: 'selectFiles' });
    expect(e._tag).toBe('UserCancelled');
  });
});
