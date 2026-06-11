import type { ReadSettings } from '@/domain/settings';
import { DEFAULT_HIGHLIGHT_COLORS } from '@/domain/book';
import type { UserHighlightColor, ViewSettings } from '@/domain/book';
import {
  DEFAULT_BOOK_LAYOUT,
  DEFAULT_BOOK_STYLE,
  DEFAULT_BOOK_FONT,
  DEFAULT_BOOK_LANGUAGE,
  DEFAULT_VIEW_CONFIG,
  DEFAULT_TTS_CONFIG,
  DEFAULT_MOBILE_VIEW_SETTINGS,
  DEFAULT_CJK_VIEW_SETTINGS,
  DEFAULT_SCREEN_CONFIG,
  DEFAULT_TRANSLATOR_CONFIG,
  DEFAULT_ANNOTATOR_CONFIG,
  DEFAULT_EINK_VIEW_SETTINGS,
  DEFAULT_VIEW_SETTINGS_CONFIG,
} from '@/services/constants';
import { getTargetLang, isCJKEnv } from '@/utils/misc';

export type ViewSettingsCtx = { readonly isMobile: boolean; readonly isEink: boolean };

export function getDefaultViewSettings(ctx: ViewSettingsCtx): ViewSettings {
  return {
    ...DEFAULT_BOOK_LAYOUT,
    ...DEFAULT_BOOK_STYLE,
    ...DEFAULT_BOOK_FONT,
    ...DEFAULT_BOOK_LANGUAGE,
    ...DEFAULT_VIEW_CONFIG,
    ...DEFAULT_TTS_CONFIG,
    ...DEFAULT_SCREEN_CONFIG,
    ...DEFAULT_ANNOTATOR_CONFIG,
    ...DEFAULT_VIEW_SETTINGS_CONFIG,
    ...(ctx.isMobile ? DEFAULT_MOBILE_VIEW_SETTINGS : {}),
    ...(ctx.isEink ? DEFAULT_EINK_VIEW_SETTINGS : {}),
    ...(isCJKEnv() ? DEFAULT_CJK_VIEW_SETTINGS : {}),
    ...{ ...DEFAULT_TRANSLATOR_CONFIG, translateTargetLang: getTargetLang() },
  };
}

/**
 * Normalize highlight color prefs into the current shape:
 * - `userHighlightColors` becomes `UserHighlightColor[]`. Legacy `string[]` entries
 *   are lifted into `{ hex }`. A legacy `highlightColorLabels` map (shipped only in
 *   draft builds of this feature) is folded in: hex entries attach to matching user
 *   colors, named entries move into `defaultHighlightLabels`.
 */
export function migrateHighlightColorPrefs(read: ReadSettings): void {
  const rawUser = (read.userHighlightColors ?? []) as unknown[];
  const userColors: UserHighlightColor[] = rawUser
    .map((entry) => {
      if (typeof entry === 'string') {
        return { hex: entry.trim().toLowerCase() };
      }
      if (entry && typeof entry === 'object' && 'hex' in entry) {
        const { hex, label } = entry as UserHighlightColor;
        return {
          hex: typeof hex === 'string' ? hex.trim().toLowerCase() : '',
          ...(label?.trim() ? { label: label.trim() } : {}),
        };
      }
      return { hex: '' };
    })
    .filter((entry) => entry.hex.startsWith('#'));

  read.defaultHighlightLabels = { ...(read.defaultHighlightLabels ?? {}) };

  const legacyLabels = (read as unknown as { highlightColorLabels?: unknown }).highlightColorLabels;
  if (legacyLabels && typeof legacyLabels === 'object') {
    const labels = legacyLabels as Record<string, unknown>;
    for (const name of DEFAULT_HIGHLIGHT_COLORS) {
      const value = labels[name];
      if (typeof value === 'string' && value.trim() && !read.defaultHighlightLabels[name]) {
        read.defaultHighlightLabels[name] = value.trim();
      }
    }
    for (const entry of userColors) {
      if (entry.label) continue;
      const value = labels[entry.hex];
      if (typeof value === 'string' && value.trim()) {
        entry.label = value.trim();
      }
    }
    delete (read as unknown as { highlightColorLabels?: unknown }).highlightColorLabels;
  }

  read.userHighlightColors = userColors;
}
