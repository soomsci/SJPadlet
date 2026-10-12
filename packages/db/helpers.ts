import { randomUUID } from 'node:crypto';
import type { Database } from './core';
export const id = () => randomUUID();
export const now = () => new Date().toISOString();
export async function emit(tx: Database, boardId: string, type = 'changed') {
  await tx.run('INSERT INTO outbox_events(board_id,event_type,created_at) VALUES($1,$2,$3)', [boardId, type, now()]);
}
export async function audit(tx: Database, actor: string, action: string, target: string) {
  await tx.run('INSERT INTO audit_events(id,actor_id,action,target_id,created_at) VALUES($1,$2,$3,$4,$5)', [id(), actor, action, target, now()]);
}
