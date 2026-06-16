import { describe, it, expect } from 'vitest';
import { isControlChar } from '@/app/api/share/create/route';

/**
 * Unit coverage for the C0/DEL control-char guard used on the share `cfi`
 * field. The guard must:
 *   - PASS ordinary epubcfi strings (digits, letters, `!`, `/`, `:`, `(`, `)`)
 *   - REJECT strings containing a real control byte (U+0000-U+001F or U+007F)
 *
 * Regression: the original regex was double-escaped (`/[\\u0000-...]/`) so it
 * matched literal `\`, `u`, digits, `f`, `7` — i.e. EVERY real cfi was
 * rejected and no actual control byte was caught.
 */
describe('share/create isControlChar', () => {
  const NUL = String.fromCharCode(0x00);
  const UNIT_SEP = String.fromCharCode(0x1f);
  const DEL = String.fromCharCode(0x7f);

  it('passes a normal epubcfi string', () => {
    expect(isControlChar('epubcfi(/6/14!/4/2/1:0)')).toBe(false);
  });

  it('passes a cfi with the characters the buggy class falsely matched', () => {
    // backslash, `u`, digits, `f`, `7` — none are control chars.
    expect(isControlChar('epubcfi(/6/14[chap07ref]!/4/2/1:7)')).toBe(false);
    expect(isControlChar('u07f\\')).toBe(false);
  });

  it('rejects a string containing a C0 control char (NUL U+0000)', () => {
    expect(isControlChar(`epubcfi(${NUL}/6)`)).toBe(true);
  });

  it('rejects a string containing a C0 control char (unit separator U+001F)', () => {
    expect(isControlChar(`ab${UNIT_SEP}cd`)).toBe(true);
  });

  it('rejects a string containing DEL (U+007F)', () => {
    expect(isControlChar(`ab${DEL}cd`)).toBe(true);
  });
});
