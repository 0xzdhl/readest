import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { md5 as browserMd5 } from '@/utils/md5';
import { md5, md5Fingerprint, partialMD5 } from '../../utils/md5';

describe('md5 utilities', () => {
  test('hashes strings and bytes with the standard MD5 digest', () => {
    expect(md5('')).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(md5('abc')).toBe('900150983cd24fb0d6963f7d28e17f72');
    expect(md5(new Uint8Array([97, 98, 99]))).toBe('900150983cd24fb0d6963f7d28e17f72');
    expect(md5('中文')).toBe('a7bac2239fcdcb3a067903d8077c4a07');
  });

  test('keeps the browser implementation compatible with node crypto output', () => {
    expect(browserMd5('')).toBe(md5(''));
    expect(browserMd5('abc')).toBe(md5('abc'));
    expect(browserMd5('中文')).toBe(md5('中文'));
    expect(browserMd5(new Uint8Array([97, 98, 99]))).toBe(md5(new Uint8Array([97, 98, 99])));
  });

  test('creates short fingerprints from MD5 hashes', () => {
    expect(md5Fingerprint('abc')).toBe('9001509');
  });

  test('hashes sampled file slices', async () => {
    const file = new File([new Uint8Array([97, 98, 99])], 'abc.txt');

    await expect(partialMD5(file)).resolves.toBe('900150983cd24fb0d6963f7d28e17f72');
  });

  test('uses the node crypto implementation without the legacy compatibility code', () => {
    const md5Source = readFileSync(resolve('src/utils/md5.ts'), 'utf8');
    const browserSource = readFileSync(resolve('src/utils/md5.browser.ts'), 'utf8');
    const oldPackageName = ['js', 'md5'].join('-');
    const oldCompatFile = ['md5', 'Compat.ts'].join('');

    expect(md5Source).toContain('node:crypto');
    expect(md5Source).not.toContain(oldPackageName);
    expect(browserSource).not.toContain(oldPackageName);
    expect(browserSource).not.toContain('node:crypto');
    expect(existsSync(resolve('src/utils', oldCompatFile))).toBe(false);
  });
});
