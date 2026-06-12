import { md5 } from '@/utils/md5';

/**
 * Build the cross-device content id for a font:
 * `md5(partialMd5 ‖ byteSize ‖ filename)`. Same recipe shape as
 * dictionary.computeReplicaId — keeps the kinds aligned.
 */
export const computeFontContentId = (
  partialMd5: string,
  byteSize: number,
  filename: string,
): string => md5(`${partialMd5}|${byteSize}|${filename}`);
