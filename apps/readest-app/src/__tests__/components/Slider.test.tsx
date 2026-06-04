import { describe, expect, it } from 'vitest';

import {
  getSliderBubbleFontSize,
  getSliderFillWidth,
  getSliderThumbOffset,
} from '@/components/Slider';

/**
 * The slider draws a fixed-width thumb bubble (`heightPx` wide) over a track of
 * unknown, responsive width `W`. To keep the bubble inside the track and aligned
 * with the pointer at every width, the thumb centre must travel linearly from
 * `heightPx/2` (left edge flush) to `W - heightPx/2` (right edge flush):
 *
 *   thumbCentre = heightPx/2 + fraction * (W - heightPx)
 *   fillWidth   = heightPx   + fraction * (W - heightPx)   (ends at the bubble's right edge)
 *
 * The previous implementation used `0.95 * percentage`, which only lands flush at
 * the right edge when `W === 10 * heightPx` — true-ish on the full-width mobile
 * slider, badly wrong on the wide desktop footer (drift + right-side gap).
 */

// Minimal evaluator for the exact calc() shape these helpers emit.
const evalCalc = (css: string, widthPx: number): number => {
  const m = css.match(/^calc\(([\d.]+)px \+ \(100% - ([\d.]+)px\) \* ([\d.]+)\)$/);
  if (!m) throw new Error(`unexpected calc format: ${css}`);
  const [, a, b, f] = m;
  return Number(a) + (widthPx - Number(b)) * Number(f);
};

describe('Slider geometry', () => {
  it('emits width-relative calc() expressions, not a hardcoded 95% scale', () => {
    const offset = getSliderThumbOffset(1, 20);
    expect(offset).toBe('calc(10px + (100% - 20px) * 1)');
    expect(offset).not.toContain('95%');

    expect(getSliderThumbOffset(0.5, 20)).toBe('calc(10px + (100% - 20px) * 0.5)');
    expect(getSliderFillWidth(1, 20)).toBe('calc(20px + (100% - 20px) * 1)');
  });

  it('places the thumb flush left at 0% and flush right at 100% for any width', () => {
    const heightPx = 24;
    for (const width of [240, 600, 1000]) {
      const centreAtStart = evalCalc(getSliderThumbOffset(0, heightPx), width);
      expect(centreAtStart - heightPx / 2).toBeCloseTo(0); // left edge at 0

      const centreAtEnd = evalCalc(getSliderThumbOffset(1, heightPx), width);
      expect(centreAtEnd + heightPx / 2).toBeCloseTo(width); // right edge at W: no leftover gap
    }
  });

  it('scales the bubble font to fit the thumb circle with breathing room', () => {
    // Shrinks relative to the previous fixed 12px (text-xs) on the compact 24px
    // desktop thumb, where "100%" used to overflow.
    expect(getSliderBubbleFontSize(24)).toBeLessThan(12);
    // Larger thumb -> larger text (monotonic).
    expect(getSliderBubbleFontSize(35)).toBeGreaterThan(getSliderBubbleFontSize(24));
    // A 4-char label like "100%" (~2.4em wide) fits inside the heightPx circle
    // with space to spare at every size the app uses.
    for (const heightPx of [24, 28, 35]) {
      expect(2.4 * getSliderBubbleFontSize(heightPx)).toBeLessThan(heightPx);
    }
  });

  it('keeps the thumb close to the pointer on a wide track (no proportional drift)', () => {
    const width = 600;
    const heightPx = 24;
    // Pointer at the far right (fraction 1) -> thumb right edge should be at the
    // far right, i.e. centre fraction ~ (W - h/2)/W, not the old 0.95.
    const centreFraction = evalCalc(getSliderThumbOffset(1, heightPx), width) / width;
    expect(centreFraction).toBeGreaterThan(0.95); // old impl was exactly 0.95
    expect(width - evalCalc(getSliderFillWidth(1, heightPx), width)).toBeCloseTo(0);
  });
});
