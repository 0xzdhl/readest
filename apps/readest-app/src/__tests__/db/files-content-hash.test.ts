import { describe, it, expect } from 'vitest';
import { files } from '@/db/schema';

describe('files schema', () => {
  it('has a nullable content_hash column', () => {
    expect(files.contentHash).toBeDefined();
    expect(files.contentHash.name).toBe('content_hash');
    expect(files.contentHash.notNull).toBe(false);
  });
});
