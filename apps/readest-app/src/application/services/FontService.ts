import { Context, type Effect } from 'effect';
import type { CustomFont, CustomFontInfo } from '@/domain/fonts';
import type { AssetError } from '@/application/errors/AppError';

export interface FontServiceShape {
  readonly importFont: (file?: string | File) => Effect.Effect<CustomFontInfo | null, AssetError>;
  readonly deleteFont: (font: CustomFont) => Effect.Effect<void, AssetError>;
}

export class FontService extends Context.Tag('app/FontService')<FontService, FontServiceShape>() {}
