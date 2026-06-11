import { Context, type Effect, type Option } from 'effect';
import type { SelectDirectoryMode } from '@/domain/system';
import type { PlatformError } from '@/application/errors/AppError';

export type SharePosition = {
  readonly x: number;
  readonly y: number;
  readonly preferredEdge?: 'top' | 'bottom' | 'left' | 'right';
};

export type SaveFileOptions = {
  readonly filePath?: string;
  readonly mimeType?: string;
  readonly share?: boolean;
  readonly sharePosition?: SharePosition;
};

export interface DialogShape {
  readonly ask: (message: string) => Effect.Effect<boolean, PlatformError>;
  readonly selectDirectory: (
    mode: SelectDirectoryMode,
  ) => Effect.Effect<Option.Option<string>, PlatformError>;
  readonly selectFiles: (
    name: string,
    extensions: string[],
  ) => Effect.Effect<readonly string[], PlatformError>;
  readonly saveFile: (
    filename: string,
    content: string | ArrayBuffer,
    options?: SaveFileOptions,
  ) => Effect.Effect<Option.Option<string>, PlatformError>;
}

export class Dialog extends Context.Tag('app/Dialog')<Dialog, DialogShape>() {}
