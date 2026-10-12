import { createCipheriv, createDecipheriv, randomBytes, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { id, now, emit, audit, type Database } from '@db';
import { setting } from '@server/common/runtime';
import { fail } from '@server/common/http';
import { BACKUP_MAX_BYTES } from './storage';

export const contentTables = ['principals', 'boards', 'sections', 'posts', 'comments', 'reactions', 'attachments', 'post_drafts', 'board_blocks'] as const;
export type SnapshotRow = Record<string, unknown>;
export interface SchoolSnapshot { version: 2; created_at: string; tables: Record<string, SnapshotRow[]>; }
const MAGIC = Buffer.from('SJMOABK2');
export function backupKey() {
  const value = setting('BACKUP_ENCRYPTION_KEY') || '';
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) fail(503, 'BACKUP_NOT_CONFIGURED', '32바이트 백업 전용 암호화 키 설정이 필요합니다.');
  const key = Buffer.from(value, 'base64url'); if (key.length !== 32 || key.toString('base64url') !== value) fail(503, 'BACKUP_NOT_CONFIGURED', '백업 전용 암호화 키를 확인해주세요.');
  return key;
}
export function encryptBytes(bytes: Uint8Array) {
  const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', backupKey(), nonce);
  cipher.setAAD(MAGIC);
  const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return Buffer.concat([MAGIC, nonce, cipher.getAuthTag(), encrypted]);
}
export function decryptBytes(bytes: Uint8Array) {
  const value = Buffer.from(bytes);
  if (value.length < 36 || !value.subarray(0, 8).equals(MAGIC)) fail(400, 'INVALID_BACKUP', '지원하지 않는 백업 형식입니다.');
  try { const decipher = createDecipheriv('aes-256-gcm', backupKey(), value.subarray(8, 20)); decipher.setAAD(MAGIC); decipher.setAuthTag(value.subarray(20, 36)); return Buffer.concat([decipher.update(value.subarray(36)), decipher.final()]); }
  catch { fail(400, 'INVALID_BACKUP', '백업 암호화 키 또는 파일의 무결성을 확인해주세요.'); }
}
export async function schoolSnapshot(db: Database): Promise<SchoolSnapshot> {
  return db.transaction(async tx => {
    await tx.run('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const tables: SchoolSnapshot['tables'] = {}; let bytes = 0;
    for (const table of contentTables) {
      tables[table] = await tx.all(table === 'principals' ? 'SELECT id,display_name,created_at FROM principals' : table === 'attachments' ? `SELECT a.* FROM attachments a JOIN boards b ON b.id=a.board_id LEFT JOIN posts p ON p.id=a.post_id WHERE (b.deleted_at IS NULL OR b.deleted_at>='${new Date(Date.now()-30*86400000).toISOString()}') AND ((a.post_id IS NOT NULL AND (p.status<>'deleted' OR p.updated_at>='${new Date(Date.now()-30*86400000).toISOString()}')) OR a.created_at>='${new Date(Date.now()-14*86400000).toISOString()}' OR EXISTS(SELECT 1 FROM post_drafts d WHERE d.attachment_ids @> jsonb_build_array(a.id)))` : `SELECT * FROM ${table}`);
      bytes += Buffer.byteLength(JSON.stringify(tables[table]));
      if (bytes > BACKUP_MAX_BYTES - 1024) fail(413, 'BACKUP_TOO_LARGE', '백업 1회 한도 10MB를 초과했습니다. 별도 내보내기가 필요합니다.');
    }
    return { version: 2, created_at: now(), tables };
  });
}
export function validateSnapshot(raw: unknown): SchoolSnapshot {
  const parsed = z.object({ version: z.literal(2), created_at: z.iso.datetime(), tables: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))) }).strict().safeParse(raw);
  if (!parsed.success || Object.keys(parsed.data.tables).length !== contentTables.length || contentTables.some(table => !Array.isArray(parsed.data.tables[table])) || Object.keys(parsed.data.tables).some(table => !contentTables.includes(table as typeof contentTables[number]))) fail(400, 'INVALID_BACKUP', '백업 테이블 구성이 올바르지 않습니다.');
  if (Buffer.byteLength(JSON.stringify(raw)) > BACKUP_MAX_BYTES) fail(413, 'BACKUP_TOO_LARGE', '백업이 너무 큽니다.');
  return parsed.data;
}
export function openSnapshot(encrypted: Uint8Array): SchoolSnapshot {
  let raw: unknown; try { raw = JSON.parse(decryptBytes(encrypted).toString('utf8')); } catch (error) { if (error instanceof SyntaxError) fail(400, 'INVALID_BACKUP', '백업 데이터가 올바르지 않습니다.'); throw error; }
  return validateSnapshot(raw);
}
export function snapshotDigest(snapshot: SchoolSnapshot) { return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'); }
export function restoreToken(actor: string, backup: string, digest: string) {
  const payload = Buffer.from(JSON.stringify({ actor, backup, digest, expires: Date.now() + 10 * 60000 })).toString('base64url');
  return payload + '.' + createHmac('sha256', backupKey()).update(payload).digest('base64url');
}
export function checkRestoreToken(token: string, actor: string, backup: string, digest: string) {
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra) fail(400, 'INVALID_RESTORE_CONFIRMATION', '복원 내용을 다시 확인해주세요.');
  const expected = createHmac('sha256', backupKey()).update(payload).digest();
  const actual = Buffer.from(signature, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) fail(400, 'INVALID_RESTORE_CONFIRMATION', '복원 확인이 일치하지 않습니다.');
  let value: { actor: string; backup: string; digest: string; expires: number };
  try { value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { fail(400, 'INVALID_RESTORE_CONFIRMATION', '복원 확인이 올바르지 않습니다.'); }
  if (value.actor !== actor || value.backup !== backup || value.digest !== digest || !(value.expires > Date.now())) fail(400, 'INVALID_RESTORE_CONFIRMATION', '복원 확인이 만료되거나 변경되었습니다.');
}
export async function mergeSchoolSnapshot(db: Database, raw: unknown, actorId: string) {
  const snapshot = validateSnapshot(raw);
  await db.transaction(async tx => {
    await tx.run('SELECT id FROM storage_budget WHERE id=1 FOR UPDATE');
    const actor = await tx.one<{ role: string; disabled_at: string | null }>('SELECT role,disabled_at FROM principals WHERE id=$1 FOR UPDATE', [actorId]);
    if (!actor || actor.role !== 'admin' || actor.disabled_at) fail(403, 'FORBIDDEN', '활성 관리자만 복원할 수 있습니다.');
    // Content recovery never reinstates authentication or historical grants.
    // Existing identity, role, disabled state and admission rules are preserved.
    for (const person of snapshot.tables.principals) {
      const row = z.object({ id: z.string().min(1), display_name: z.string().max(200), created_at: z.string().min(1) }).strict().safeParse(person);
      if (!row.success) fail(400, 'INVALID_BACKUP', '백업 사용자 정보가 올바르지 않습니다.');
      await tx.run("INSERT INTO principals(id,role,display_name,created_at) VALUES($1,'anonymous',$2,$3) ON CONFLICT(id) DO NOTHING", [row.data.id, row.data.display_name, row.data.created_at]);
    }
    for (const table of contentTables.filter(table => table !== 'principals')) {
      const columns = await tx.all<{ column_name: string; data_type: string }>('SELECT column_name,data_type FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2', ['public', table]);
      const allowed = new Map(columns.map(column => [column.column_name, column.data_type]));
      for (const original of snapshot.tables[table]) {
        const row = { ...original };
        if (table === 'boards') { row.owner_id = actorId; row.state = 'closed'; row.updated_at = now(); }
        const entries = Object.entries(row);
        if (!entries.length || entries.some(([column]) => !allowed.has(column))) fail(400, 'INVALID_BACKUP', '백업 열 구성이 올바르지 않습니다.');
        const key = table === 'reactions' ? ['post_id', 'principal_id'] : table === 'board_blocks' ? ['board_id', 'principal_id'] : ['id'];
        if (key.some(column => !(column in row))) fail(400, 'INVALID_BACKUP', '백업 식별자가 올바르지 않습니다.');
        const changes = entries.filter(([column]) => !key.includes(column)).map(([column]) => column === 'version' ? `"version"=GREATEST(${table}.version,EXCLUDED.version)+1` : `"${column}"=EXCLUDED."${column}"`);
        // Never remove new rows created after the snapshot. Blocks only accumulate.
        const conflict = table === 'board_blocks' || !changes.length ? 'DO NOTHING' : 'DO UPDATE SET ' + changes.join(',');
        await tx.run(`INSERT INTO ${table}(${entries.map(([column]) => '"' + column + '"').join(',')}) VALUES(${entries.map((_, index) => '$' + (index + 1)).join(',')}) ON CONFLICT(${key.join(',')}) ${conflict}`, entries.map(([column, value]) => allowed.get(column) === 'jsonb' ? JSON.stringify(value) : value));
      }
    }
    for (const board of snapshot.tables.boards) {
      await tx.run('UPDATE share_links SET revoked_at=$1,version=version+1 WHERE board_id=$2 AND revoked_at IS NULL', [now(), board.id]);
      await tx.run('DELETE FROM participations WHERE board_id=$1', [board.id]);
      await tx.run('DELETE FROM board_members WHERE board_id=$1', [board.id]);
      await emit(tx, String(board.id), 'permissions');
    }
    // Current sessions can belong to users with in-flight work against old data.
    await tx.run('DELETE FROM sessions'); await tx.run('DELETE FROM oauth_states');
    await audit(tx, actorId, 'school.restore', id());
  });
}
