declare module 'node:sqlite' {
  export class DatabaseSync {
    public constructor(filename: string);
    public exec(sql: string): void;
    public prepare(sql: string): StatementSync;
    public close(): void;
  }
  export class StatementSync {
    public run(...params: unknown[]): { changes: number; lastInsertRowid: number };
    public get(...params: unknown[]): Record<string, unknown> | undefined;
    public all(...params: unknown[]): Record<string, unknown>[];
  }
}
