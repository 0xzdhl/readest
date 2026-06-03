import { describe, it, expect, vi } from 'vitest';

vi.mock('@/services/environment', () => ({
  getBaseUrl: () => 'https://web.example.com',
}));

import {
  buildAnnotationWebUrl,
  buildAnnotationAppUrl,
  parseAnnotationDeepLink,
} from '@/utils/deeplink';

describe('buildAnnotationWebUrl', () => {
  it('builds an https annotation URL on the configured host', () => {
    expect(buildAnnotationWebUrl({ bookHash: 'h1', noteId: 'n1' })).toBe(
      'https://web.example.com/o/book/h1/annotation/n1',
    );
  });
  it('appends an encoded cfi when provided', () => {
    expect(buildAnnotationWebUrl({ bookHash: 'h1', noteId: 'n1', cfi: 'epubcfi(/6/4)' })).toBe(
      'https://web.example.com/o/book/h1/annotation/n1?cfi=epubcfi(%2F6%2F4)',
    );
  });
});

describe('buildAnnotationAppUrl', () => {
  it('builds a readest:// annotation URL', () => {
    expect(buildAnnotationAppUrl({ bookHash: 'h1', noteId: 'n1' })).toBe(
      'readest://book/h1/annotation/n1',
    );
  });
});

describe('parseAnnotationDeepLink', () => {
  it('parses the https hierarchical form on the configured host', () => {
    expect(parseAnnotationDeepLink('https://web.example.com/o/book/h1/annotation/n1')).toEqual({
      bookHash: 'h1',
      noteId: 'n1',
      cfi: undefined,
    });
  });
  it('parses the readest:// custom scheme', () => {
    expect(parseAnnotationDeepLink('readest://book/h1/annotation/n1')).toEqual({
      bookHash: 'h1',
      noteId: 'n1',
      cfi: undefined,
    });
  });
  it('parses the legacy flat form', () => {
    expect(parseAnnotationDeepLink('readest://annotation/h1/n1')).toEqual({
      bookHash: 'h1',
      noteId: 'n1',
      cfi: undefined,
    });
  });
  it('rejects https URLs from a different host', () => {
    expect(parseAnnotationDeepLink('https://evil.org/o/book/h1/annotation/n1')).toBeNull();
  });
  it('returns null for malformed input', () => {
    expect(parseAnnotationDeepLink('not-a-url')).toBeNull();
  });
});
