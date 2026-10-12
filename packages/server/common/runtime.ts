import { AsyncLocalStorage } from 'node:async_hooks';
import type { Database } from '../../db/core';

export interface RequestContext {
  values: Record<string, string | undefined>;
  database: () => Promise<Database>;
}

// A Worker isolate serves overlapping requests. Never put request secrets or
// database connections in process.env or a module-level mutable variable.
const requests = new AsyncLocalStorage<RequestContext>();
export const withRequestContext = <T>(context: RequestContext, fn: () => T): T => requests.run(context, fn);
export const requestContext = () => requests.getStore();
export const setting = (name: string) => requests.getStore()?.values[name] ?? process.env[name];
