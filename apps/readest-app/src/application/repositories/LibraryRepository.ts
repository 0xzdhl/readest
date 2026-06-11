import { Context, type Effect } from 'effect';
import type { Book } from '@/domain/book';
import type { BookError } from '@/application/errors/AppError';

export interface LibraryRepositoryShape {
  readonly load: Effect.Effect<Book[], BookError>;
  readonly save: (books: readonly Book[]) => Effect.Effect<void, BookError>;
}

export class LibraryRepository extends Context.Tag('app/LibraryRepository')<
  LibraryRepository,
  LibraryRepositoryShape
>() {}
