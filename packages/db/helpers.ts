import { randomUUID } from 'node:crypto';
import type { Database } from './core';
export const id = () => randomUUID();
export const now = () => new Date().toISOString();
export async function emit(tx: Database, boardId: string, type = 'changed') {
  await tx.run('INSERT INTO outbox_events(board_id,event_type,created_at) VALUES($1,$2,$3)', [boardId, type, now()]);
}
/** `boardId` marks teacher actions shown in that board's activity panel (managers only). */
export async function audit(tx: Database, actor: string, action: string, target: string, boardId: string | null = null) {
  await tx.run('INSERT INTO audit_events(id,actor_id,action,target_id,created_at,board_id) VALUES($1,$2,$3,$4,$5,$6)', [id(), actor, action, target, now(), boardId]);
}
