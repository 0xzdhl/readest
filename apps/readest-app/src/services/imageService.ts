import { md5 } from '@/utils/md5';

/**
 * Build the cross-device content id for a texture:
 * `md5(partialMd5 ‖ byteSize ‖ filename)`. Same recipe shape as
 * fontService.computeFontContentId — keeps the kinds aligned.
 */
export const computeTextureContentId = (
  partialMd5: string,
  byteSize: number,
  filename: string,
): string => md5(`${partialMd5}|${byteSize}|${filename}`);
