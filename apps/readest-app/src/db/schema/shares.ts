import { bigint, index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { user } from './auth';

export const bookShares = pgTable(
  'book_shares',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tokenHash: text('token_hash').notNull().unique(),
    token: text('token').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    bookHash: text('book_hash').notNull(),
    bookTitle: text('book_title').notNull(),
    bookAuthor: text('book_author'),
    bookFormat: text('book_format').notNull(),
    bookSize: bigint('book_size', { mode: 'number' }).notNull(),
    cfi: text('cfi'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    downloadCount: integer('download_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_book_shares_user_id').on(t.userId),
    index('idx_book_shares_user_id_book_hash').on(t.userId, t.bookHash),
  ],
);
