import type { BookConfig } from '@/domain/book';
import type { AppService } from '@/domain/system';

import type { AnnotationProviderName } from './providers';

export interface AnnotationImportProvider {
  name: string;
  /** Check whether this provider is applicable on the current platform. */
  isAvailable: (appService: AppService) => boolean;
  /** Import annotations for a book, merging with the current config. */
  importAnnotations: (
    appService: AppService,
    identifier: string,
    config: BookConfig,
  ) => Promise<BookConfig>;
}

export interface UseAnnotationImportOptions {
  provider?: AnnotationProviderName;
}
