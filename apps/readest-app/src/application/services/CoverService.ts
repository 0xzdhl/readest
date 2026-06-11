import { Context, type Effect } from 'effect';
import type { Book } from '@/domain/book';
import type { BookError } from '@/application/errors/AppError';

export interface CoverServiceShape {
  readonly getCoverImageUrl: (book: Book) => string;
  readonly getCoverImageBlobUrl: (book: Book) => Effect.Effect<string, BookError>;
  readonly getCachedImageUrl: (pathOrUrl: string) => Effect.Effect<string, BookError>;
  readonly generateCoverImageUrl: (book: Book) => Effect.Effect<string, BookError>;
  readonly updateCoverImage: (
    book: Book,
    imageUrl?: string,
    imageFile?: string,
  ) => Effect.Effect<void, BookError>;
}

export class CoverService extends Context.Tag('app/CoverService')<
  CoverService,
  CoverServiceShape
>() {}
