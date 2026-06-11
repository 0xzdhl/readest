import { Context, type Effect } from 'effect';
import type { Book } from '@/domain/book';
import type { BookMetadata } from '@/domain/document';
import type { BaseDir, DeleteAction } from '@/domain/system';
import type { ProgressHandler } from '@/domain/transfer';
import type { CloudError } from '@/application/errors/AppError';

export interface ReplicaFileOpts {
  readonly kind: string;
  readonly replicaId: string;
  readonly filename: string;
  readonly lfp: string;
  readonly base: BaseDir;
  readonly onProgress: ProgressHandler;
}

export interface ReplicaDownloadOpts {
  readonly kind: string;
  readonly replicaId: string;
  readonly filename: string;
  readonly lfp: string;
  readonly base: BaseDir;
  readonly onProgress?: ProgressHandler;
}

export interface CloudServiceShape {
  readonly uploadBook: (
    book: Book,
    onProgress?: ProgressHandler,
  ) => Effect.Effect<void, CloudError>;
  readonly downloadBook: (
    book: Book,
    onlyCover?: boolean,
    redownload?: boolean,
    onProgress?: ProgressHandler,
  ) => Effect.Effect<void, CloudError>;
  readonly downloadBookCovers: (books: Book[]) => Effect.Effect<void, CloudError>;
  readonly downloadCloudFile: (
    lfp: string,
    cfp: string,
    onProgress: ProgressHandler,
  ) => Effect.Effect<void, CloudError>;
  readonly uploadFileToCloud: (
    lfp: string,
    cfp: string,
    base: BaseDir,
    onProgress: ProgressHandler,
    hash: string,
    temp?: boolean,
  ) => Effect.Effect<string | undefined, CloudError>;
  readonly uploadReplicaFile: (opts: ReplicaFileOpts) => Effect.Effect<void, CloudError>;
  readonly downloadReplicaFile: (opts: ReplicaDownloadOpts) => Effect.Effect<void, CloudError>;
  readonly deleteReplicaBundle: (
    kind: string,
    replicaId: string,
    filenames: string[],
  ) => Effect.Effect<void, CloudError>;
  readonly deleteBook: (book: Book, deleteAction: DeleteAction) => Effect.Effect<void, CloudError>;
  readonly fetchBookDetails: (book: Book) => Effect.Effect<BookMetadata, CloudError>;
}

export class CloudService extends Context.Tag('app/CloudService')<
  CloudService,
  CloudServiceShape
>() {}
