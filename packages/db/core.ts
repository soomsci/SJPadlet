export interface Database {
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  one<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null>;
  run(sql: string, params?: unknown[]): Promise<void>;
  transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T>;
}
export type Engine = { query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }> };
export function wrap(engine: Engine, transaction: Database['transaction']): Database {
  return {
    async all<T>(sql: string, params: unknown[] = []) { return (await engine.query<T>(sql, params)).rows; },
    async one<T>(sql: string, params: unknown[] = []) { return (await engine.query<T>(sql, params)).rows[0] ?? null; },
    async run(sql, params = []) { await engine.query(sql, params); },
    transaction,
  };
}
