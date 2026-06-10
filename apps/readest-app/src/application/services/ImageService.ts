import { Context, type Effect } from 'effect';
import type { CustomTextureInfo } from '@/domain/textures';
import type { AssetError } from '@/application/errors/AppError';

export interface ImageServiceShape {
  readonly importImage: (
    file?: string | File,
  ) => Effect.Effect<CustomTextureInfo | null, AssetError>;
  readonly deleteImage: (texture: CustomTextureInfo) => Effect.Effect<void, AssetError>;
}

export class ImageService extends Context.Tag('app/ImageService')<
  ImageService,
  ImageServiceShape
>() {}
