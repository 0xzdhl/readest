export interface MigrationEntry {
  /** Migration name, e.g. "2026030601_initial_schema" */
  name: string;
  /** SQL statements separated by semicolons */
  sql: string;
}

/**
 * Discriminator for databases with different schemas.
 * Add new schema types here as needed.
 */
export type SchemaType = string;

export interface MigrateOptions {
  /** Name of the tracking table. @default '__migrations' */
  table?: string;
}
