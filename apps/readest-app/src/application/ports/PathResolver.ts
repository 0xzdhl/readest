import { Context, type Effect } from 'effect';
import type { BaseDir, ResolvedPath } from '@/domain/system';
import type { FsError } from '@/application/errors/AppError';

export interface PathResolverShape {
  readonly resolve: (path: string, base: BaseDir) => Effect.Effect<ResolvedPath, FsError>;
  readonly prefix: (base: BaseDir) => Effect.Effect<string, FsError>;
  readonly absolute: (path: string, base: BaseDir) => Effect.Effect<string, FsError>;
}

export class PathResolver extends Context.Tag('app/PathResolver')<
  PathResolver,
  PathResolverShape
>() {}
