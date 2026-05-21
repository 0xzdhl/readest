import {
  pgTable,
  text,
  timestamp,
  uuid,
  bigint,
  index,
} from 'drizzle-orm/pg-core';
import { user } from './auth';

export const files = pgTable(
  'files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    bookHash: text('book_hash'),
    fileKey: text('file_key').notNull().unique(),
    fileSize: bigint('file_size', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    // Added in migration 007
    replicaKind: text('replica_kind'),
    replicaId: text('replica_id'),
  },
  (t) => [
    index('idx_files_user_id_deleted_at').on(t.userId, t.deletedAt),
    index('idx_files_file_key').on(t.fileKey),
    index('idx_files_file_key_deleted_at').on(t.fileKey, t.deletedAt),
    index('idx_files_replica_lookup').on(t.userId, t.replicaKind, t.replicaId),
  ],
);
