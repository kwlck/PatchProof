import type { DatabaseSync } from 'node:sqlite';

export interface SqliteColumnMigration {
  table: string;
  column: string;
  sql: string;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/u;

function existingColumns(database: DatabaseSync, table: string): Set<string> {
  if (!IDENTIFIER.test(table)) throw new Error('SQLite migration table name is invalid');
  const rows = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name?: unknown;
  }>;
  return new Set(
    rows
      .map((row) => row.name)
      .filter((name): name is string => typeof name === 'string' && name.length > 0),
  );
}

/** Add only genuinely missing columns; all other SQLite failures propagate. */
export function applySqliteColumnMigrations(
  database: DatabaseSync,
  migrations: readonly SqliteColumnMigration[],
): void {
  const cache = new Map<string, Set<string>>();
  for (const migration of migrations) {
    if (!IDENTIFIER.test(migration.table) || !IDENTIFIER.test(migration.column))
      throw new Error('SQLite migration identifier is invalid');
    let columns = cache.get(migration.table);
    if (columns === undefined) {
      columns = existingColumns(database, migration.table);
      cache.set(migration.table, columns);
    }
    if (columns.has(migration.column)) continue;
    database.exec(migration.sql);
    columns.add(migration.column);
  }
}
