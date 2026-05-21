import {
  pgTable,
  text,
  timestamp,
  integer,
  jsonb,
  index,
  primaryKey,
  customType,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { user } from './auth';

// Custom type for bytea
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

export const replicaKeys = pgTable(
  'replica_keys',
  {
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    saltId: text('salt_id').notNull(),
    alg: text('alg').notNull(),
    salt: bytea('salt').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.saltId] })],
);

export const replicas = pgTable(
  'replicas',
  {
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    replicaId: text('replica_id').notNull(),
    fieldsJsonb: jsonb('fields_jsonb').notNull().default(sql`'{}'::jsonb`),
    manifestJsonb: jsonb('manifest_jsonb'),
    deletedAtTs: text('deleted_at_ts'),
    reincarnation: text('reincarnation'),
    updatedAtTs: text('updated_at_ts').notNull(),
    schemaVersion: integer('schema_version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    modifiedAt: timestamp('modified_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.kind, t.replicaId] }),
    check(
      'replicas_kind_allowlist',
      sql`${t.kind} IN ('dictionary', 'font', 'texture', 'opds_catalog', 'settings')`,
    ),
    check(
      'replicas_fields_size',
      sql`pg_column_size(${t.fieldsJsonb}) <= 65536`,
    ),
    check(
      'replicas_schema_version',
      sql`${t.schemaVersion} >= 1 AND ${t.schemaVersion} <= 1000`,
    ),
    index('idx_replicas_pull_cursor').on(t.userId, t.kind, t.updatedAtTs),
  ],
);
