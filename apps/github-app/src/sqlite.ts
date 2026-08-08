import { DatabaseSync } from 'node:sqlite';
import type { ManagedStateStore } from '@patchproof/github';

export class SqliteStateStore implements ManagedStateStore {
  private readonly database: DatabaseSync;

  public constructor(filename = ':memory:') {
    this.database = new DatabaseSync(filename);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS deliveries (
        delivery_id TEXT PRIMARY KEY,
        received_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runs (
        repository TEXT NOT NULL,
        pull_request INTEGER NOT NULL,
        check_id INTEGER,
        comment_id INTEGER,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (repository, pull_request)
      );
    `);
  }

  public getDelivery(deliveryId: string): Promise<boolean> {
    return Promise.resolve(
      this.database
        .prepare('SELECT delivery_id FROM deliveries WHERE delivery_id = ?')
        .get(deliveryId) !== undefined,
    );
  }

  public markDelivery(deliveryId: string): Promise<void> {
    this.database
      .prepare('INSERT OR IGNORE INTO deliveries(delivery_id, received_at) VALUES (?, ?)')
      .run(deliveryId, new Date().toISOString());
    return Promise.resolve();
  }

  public getRun(
    repository: string,
    pullRequest: number,
  ): Promise<{ checkId?: number; commentId?: number } | undefined> {
    const row = this.database
      .prepare('SELECT check_id, comment_id FROM runs WHERE repository = ? AND pull_request = ?')
      .get(repository, pullRequest);
    if (row === undefined) return Promise.resolve(undefined);
    return Promise.resolve({
      ...(typeof row.check_id === 'number' ? { checkId: row.check_id } : {}),
      ...(typeof row.comment_id === 'number' ? { commentId: row.comment_id } : {}),
    });
  }

  public putRun(
    repository: string,
    pullRequest: number,
    value: { checkId?: number; commentId?: number },
  ): Promise<void> {
    this.database
      .prepare(
        `
      INSERT INTO runs(repository, pull_request, check_id, comment_id, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(repository, pull_request) DO UPDATE SET check_id=excluded.check_id, comment_id=excluded.comment_id, updated_at=excluded.updated_at
    `,
      )
      .run(
        repository,
        pullRequest,
        value.checkId ?? null,
        value.commentId ?? null,
        new Date().toISOString(),
      );
    return Promise.resolve();
  }

  public close(): void {
    this.database.close();
  }
}
