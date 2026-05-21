import {
  pgTable,
  text,
  timestamp,
  integer,
  json,
  jsonb,
  primaryKey,
} from 'drizzle-orm/pg-core';
import { user } from './auth';

export const books = pgTable(
  'books',
  {
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    bookHash: text('book_hash').notNull(),
    metaHash: text('meta_hash'),
    format: text('format'),
    title: text('title'),
    sourceTitle: text('source_title'),
    author: text('author'),
    group: text('group'),
    tags: text('tags').array(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }),
    progress: integer('progress').array(),
    readingStatus: text('reading_status'),
    groupId: text('group_id'),
    groupName: text('group_name'),
    metadata: json('metadata'),
  },
  (t) => [primaryKey({ columns: [t.userId, t.bookHash] })],
);

export const bookConfigs = pgTable(
  'book_configs',
  {
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    bookHash: text('book_hash').notNull(),
    metaHash: text('meta_hash'),
    location: text('location'),
    xpointer: text('xpointer'),
    progress: jsonb('progress'),
    rsvpPosition: text('rsvp_position'),
    searchConfig: jsonb('search_config'),
    viewSettings: jsonb('view_settings'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.userId, t.bookHash] })],
);

export const bookNotes = pgTable(
  'book_notes',
  {
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    bookHash: text('book_hash').notNull(),
    metaHash: text('meta_hash'),
    id: text('id').notNull(),
    type: text('type'),
    cfi: text('cfi'),
    xpointer0: text('xpointer0'),
    xpointer1: text('xpointer1'),
    text: text('text'),
    style: text('style'),
    color: text('color'),
    note: text('note'),
    page: integer('page'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.userId, t.bookHash, t.id] })],
);
