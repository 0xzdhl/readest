import { Context, type Effect } from 'effect';
import type { Book, BookConfig, BookContent } from '@/domain/book';
import type { BookNav } from '@/domain/nav';
import type { SystemSettings } from '@/domain/settings';
import type { BookError } from '@/application/errors/AppError';

export interface BookRepositoryShape {
  readonly loadContent: (book: Book) => Effect.Effect<BookContent, BookError>;
  readonly loadConfig: (
    book: Book,
    settings: SystemSettings,
  ) => Effect.Effect<BookConfig, BookError>;
  readonly saveConfig: (
    book: Book,
    config: BookConfig,
    settings?: SystemSettings,
  ) => Effect.Effect<void, BookError>;
  readonly loadNav: (book: Book) => Effect.Effect<BookNav | null, BookError>;
  readonly saveNav: (book: Book, nav: BookNav) => Effect.Effect<void, BookError>;
  readonly getFileSize: (book: Book) => Effect.Effect<number | null, BookError>;
  readonly isAvailable: (book: Book) => Effect.Effect<boolean, BookError>;
}

export class BookRepository extends Context.Tag('app/BookRepository')<
  BookRepository,
  BookRepositoryShape
>() {}
