import { Context, type Effect } from 'effect';
import type { BaseDir } from '@/domain/system';
import type { DatabaseOpts, DatabaseService } from '@/domain/database';
import type { SchemaType } from '@/domain/migration';
import type { DatabaseError } from '@/application/errors/AppError';

export type OpenDatabaseInput = {
  readonly schema: SchemaType;
  readonly path: string;
  readonly base: BaseDir;
  readonly opts?: DatabaseOpts;
};

export interface DatabaseShape {
  readonly open: (input: OpenDatabaseInput) => Effect.Effect<DatabaseService, DatabaseError>;
}

export class Database extends Context.Tag('app/Database')<Database, DatabaseShape>() {}
