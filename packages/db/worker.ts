import { requestContext } from '../server/common/runtime';
export type { Database } from './core';
export { id, now, emit, audit } from './helpers';
export function getDb() {
  const context = requestContext();
  if (!context) throw new Error('Database access requires a Worker request context.');
  return context.database();
}
