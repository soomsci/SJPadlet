import { z } from 'zod';
import type { Attachment, OperationRun } from '@contracts';
import { getDb, id, now, audit, type Database } from '@db';
import { requirePrincipal } from '@server/auth';
import { assertSameOrigin, fail, input, json } from '@server/common/http';
import { setting } from '@server/common/runtime';
import { deleteObject, getObject } from '@server/media/storage';
import { backupKey, checkRestoreToken, encryptBytes, mergeSchoolSnapshot, openSnapshot, restoreToken, schoolSnapshot, snapshotDigest } from './snapshot';
import { BACKUP_BUDGET_BYTES, BACKUP_MAX_BYTES, BACKUP_RETENTION_DAYS, readBackupObject, removeBackupObject, saveBackupObject, storageConfiguration, verifyImageObjects } from './storage';

const day = 86400000;
const cutoff = (days: number) => new Date(Date.now() - days * day).toISOString();
const restoredNotice = '현재 데이터에 병합하며 이후 새 글은 유지합니다. 복구 게시판은 닫힘·관리자 소유로 바뀝니다. 기존 참여와 공동 교사 권한을 회수하고 모든 계정을 로그아웃합니다.';
export const fileNotice = '백업에는 이미지 원본을 매일 복제하지 않고 비공개 원본 참조를 보호합니다. Supabase 프로젝트나 원본 파일을 직접 삭제하면 이 백업만으로 이미지를 복구할 수 없습니다. 별도 암호화 파일 묶음을 내려받아 외부에 보관하세요.';

async function startRun(db: Database, kind: OperationRun['kind'], actor: string) {
  return db.transaction(async tx => {
    await tx.run('SELECT id FROM storage_budget WHERE id=1 FOR UPDATE');
    await tx.run("UPDATE operation_runs SET status='failed',message='실행 시간 제한을 초과했습니다.',completed_at=$1 WHERE status='running' AND created_at<$2", [now(), cutoff(1 / 24)]);
    if (await tx.one("SELECT id FROM operation_runs WHERE status='running' LIMIT 1")) fail(409, 'OPERATION_BUSY', '다른 운영 작업이 진행 중입니다. 잠시 후 다시 시도해주세요.');
    const runId = id();
    await tx.run("INSERT INTO operation_runs(id,kind,status,created_at) VALUES($1,$2,'running',$3)", [runId, kind, now()]);
    await audit(tx, actor, 'operation.' + kind, runId); return runId;
  });
}
async function finishRun(db: Database, runId: string, status: 'completed' | 'failed', message: string, bytes = 0, storageKey: string | null = null) {
  await db.run('UPDATE operation_runs SET status=$1,message=$2,bytes=$3,storage_key=$4,completed_at=$5 WHERE id=$6', [status, message, bytes, storageKey, now(), runId]);
  return (await db.one<OperationRun>('SELECT * FROM operation_runs WHERE id=$1', [runId]))!;
}
async function retainedBackups(db: Database) { return db.all<OperationRun>("SELECT * FROM operation_runs WHERE kind='backup' AND status='completed' AND storage_key IS NOT NULL ORDER BY created_at DESC"); }
async function removeStoredBackup(db: Database, run: OperationRun) {
  if (!run.storage_key) return;
  await removeBackupObject(run.storage_key);
  await db.transaction(async tx => { await tx.run('DELETE FROM backup_object_refs WHERE backup_id=$1', [run.id]); await tx.run("UPDATE operation_runs SET storage_key=NULL,bytes=0,message='보관 기간이 끝나 정리된 백업입니다.' WHERE id=$1", [run.id]); });
}
export async function performBackup(db: Database, actor = 'scheduled') {
  backupKey(); storageConfiguration();
  const runId = await startRun(db, 'backup', actor); let storedKey: string | null = null;
  try {
    const snapshot = await schoolSnapshot(db), bytes = encryptBytes(Buffer.from(JSON.stringify(snapshot)));
    if (bytes.length > BACKUP_MAX_BYTES + 36) fail(413, 'BACKUP_TOO_LARGE', '백업 한도를 초과했습니다.');
    // Keep at most six older snapshots before storing the seventh. No images
    // are copied, so classroom-images 800MB + snapshots 100MB remains bounded.
    const previous = await retainedBackups(db);
    let used = previous.reduce((sum, run) => sum + run.bytes, 0), count = previous.length;
    for (const old of [...previous].reverse()) {
      if (old.created_at < cutoff(BACKUP_RETENTION_DAYS) || count >= 7 || used + bytes.length > BACKUP_BUDGET_BYTES) { await removeStoredBackup(db, old); used -= old.bytes; count--; }
    }
    storedKey = runId + '.sjbackup'; await saveBackupObject(storedKey, bytes);
    await db.transaction(async tx => {
      for (const attachment of snapshot.tables.attachments) await tx.run('INSERT INTO backup_object_refs(backup_id,attachment_id,storage_key,bytes) VALUES($1,$2,$3,$4)', [runId, attachment.id, attachment.storage_key, attachment.bytes]);
      await finishRun(tx, runId, 'completed', '암호화 콘텐츠 백업과 이미지 참조를 저장했습니다.', bytes.length, storedKey);
    });
    return (await db.one<OperationRun>('SELECT * FROM operation_runs WHERE id=$1', [runId]))!;
  } catch (error) {
    if (storedKey) await removeBackupObject(storedKey).catch(() => undefined);
    await finishRun(db, runId, 'failed', '백업을 완료하지 못했습니다. 설정과 한도를 확인해주세요.'); throw error;
  }
}
function candidateQuery() {
  return `SELECT a.* FROM attachments a JOIN boards b ON b.id=a.board_id LEFT JOIN posts p ON p.id=a.post_id
    WHERE ((a.post_id IS NULL AND a.created_at<$1) OR (p.status='deleted' AND p.updated_at<$2) OR (b.deleted_at IS NOT NULL AND b.deleted_at<$2))
    AND NOT EXISTS(SELECT 1 FROM post_drafts d WHERE d.attachment_ids @> jsonb_build_array(a.id))
    AND NOT EXISTS(SELECT 1 FROM backup_object_refs r JOIN operation_runs o ON o.id=r.backup_id WHERE r.storage_key=a.storage_key AND o.status IN ('completed','running') AND o.storage_key IS NOT NULL)
    ORDER BY a.created_at LIMIT 100`;
}
export async function cleanupCandidates(db: Database) { return db.all<Attachment>(candidateQuery(), [cutoff(14), cutoff(30)]); }
export async function performCleanup(db: Database, actor = 'scheduled') {
  const runId = await startRun(db, 'cleanup', actor); let removed = 0, bytes = 0;
  try {
    // Expire drafts before selecting abandoned uploads. Do not delete unknown
    // Storage objects: their ownership cannot be established from app metadata.
    await db.run('DELETE FROM post_drafts WHERE updated_at<$1', [cutoff(14)]);
    for (const item of await cleanupCandidates(db)) {
      await db.transaction(async tx => {
        await tx.run('SELECT id FROM storage_budget WHERE id=1 FOR UPDATE');
        await tx.run('SELECT id FROM boards WHERE id=$1 FOR UPDATE', [item.board_id]);
        await tx.run('SELECT id FROM attachments WHERE id=$1 FOR UPDATE', [item.id]);
        const fresh = (await cleanupCandidates(tx)).find(candidate => candidate.id === item.id);
        if (!fresh) return;
        await deleteObject(item.storage_key);
        await tx.run('DELETE FROM attachments WHERE id=$1', [item.id]); removed++; bytes += item.bytes;
      });
    }
    await db.run('DELETE FROM oauth_states WHERE expires_at<$1', [now()]);
    await db.run('DELETE FROM sessions WHERE expires_at<$1', [now()]);
    await db.run('DELETE FROM rate_limits WHERE resets_at<$1', [now()]);
    await db.run('DELETE FROM idempotency WHERE created_at<$1', [cutoff(14)]);
    await db.run('DELETE FROM audit_events WHERE created_at<$1', [cutoff(90)]);
    await db.run('DELETE FROM outbox_events WHERE created_at<$1', [cutoff(7)]);
    return await finishRun(db, runId, 'completed', `오래된 첨부 ${removed}개를 정리했습니다.`, bytes);
  } catch (error) { await finishRun(db, runId, 'failed', `첨부 ${removed}개 정리 후 중단되었습니다. 다시 실행할 수 있습니다.`, bytes); throw error; }
}
export async function runMaintenance() {
  const db = await getDb();
  // Cleanup must still run when backup is not configured; it preserves all
  // registered snapshot references and never removes known linked live files.
  let backupError: unknown;
  if (setting('BACKUP_ENCRYPTION_KEY')) { try { await performBackup(db); } catch (error) { backupError = error; } }
  await performCleanup(db);
  if (backupError) throw backupError;
}
async function storedSnapshot(db: Database, backupId: string) {
  const backup = await db.one<OperationRun>("SELECT * FROM operation_runs WHERE id=$1 AND kind='backup' AND status='completed' AND storage_key IS NOT NULL", [backupId]);
  if (!backup?.storage_key) fail(404, 'NOT_FOUND', '보관 중인 백업을 찾을 수 없습니다.');
  const encrypted = await readBackupObject(backup.storage_key); return { backup, encrypted, snapshot: openSnapshot(encrypted) };
}
export async function handleOperations(req: Request, path: string[]): Promise<Response | null> {
  if (path[0] !== 'admin' || path[1] !== 'operations') return null;
  assertSameOrigin(req);
  const actor = await requirePrincipal(req); if (actor.role !== 'admin') fail(403, 'FORBIDDEN', '학교 관리자만 이용할 수 있습니다.');
  const db = await getDb(), action = path[2];
  if (action === 'usage' && req.method === 'GET' && path.length === 3) {
    const files = await db.one<{ bytes: string; count: number }>('SELECT COALESCE(sum(bytes),0)::text AS bytes,count(*)::int AS count FROM attachments');
    const backups = await retainedBackups(db);
    const protectedFiles = await db.one<{ count: number }>('SELECT count(DISTINCT storage_key)::int AS count FROM backup_object_refs');
    const size = await db.one<{ bytes: string }>('SELECT pg_database_size(current_database())::text AS bytes');
    return json({ images: { bytes: Number(files?.bytes || 0), count: files?.count || 0, limit_bytes: 800 * 1024 ** 2 }, backups: { bytes: backups.reduce((sum, backup) => sum + backup.bytes, 0), count: backups.length, limit_bytes: BACKUP_BUDGET_BYTES, retention_days: BACKUP_RETENTION_DAYS, max_snapshot_bytes: BACKUP_MAX_BYTES }, database: { bytes: Number(size?.bytes || 0), limit_bytes: 500 * 1024 ** 2 }, protected_files: protectedFiles?.count || 0, backup_configured: Boolean(setting('BACKUP_ENCRYPTION_KEY') && setting('SUPABASE_URL') && setting('SUPABASE_SECRET_KEY')), external_usage: { measured: false, message: '월 전송량·실시간 연결·Worker 요청/CPU는 Cloudflare 및 Supabase 사용량 화면에서 확인해주세요. 앱 표시는 DB와 앱이 관리하는 이미지·백업 용량입니다.' }, file_notice: fileNotice });
  }
  if (action === 'backups' && req.method === 'GET' && path.length === 3) return json(await retainedBackups(db));
  if (action === 'runs' && req.method === 'GET' && path.length === 3) return json(await db.all<OperationRun>('SELECT * FROM operation_runs ORDER BY created_at DESC LIMIT 30'));
  if (action === 'backup' && req.method === 'POST' && path.length === 3) return json(await performBackup(db, actor.id), 201);
  if (action === 'cleanup' && req.method === 'GET' && path.length === 3) { const candidates = await cleanupCandidates(db); return json({ count: candidates.length, bytes: candidates.reduce((sum, file) => sum + file.bytes, 0), batch_limit: 100, message: '14일 지난 미게시 첨부와 30일 지난 삭제 글·게시판 첨부 중 초안·백업에 필요 없는 파일만 정리합니다.' }); }
  if (action === 'cleanup' && req.method === 'POST' && path.length === 3) { await input(req, z.object({ confirmation: z.literal('오래된 파일 정리') })); return json(await performCleanup(db, actor.id)); }
  if (action === 'backups' && path[3] && req.method === 'GET') {
    const { backup, encrypted, snapshot } = await storedSnapshot(db, path[3]);
    if (path.length === 5 && path[4] === 'download') { await audit(db, actor.id, 'backup.download', backup.id); return new Response(encrypted, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${backup.storage_key}"`, 'Cache-Control': 'private,no-store' } }); }
    if (path.length === 5 && path[4] === 'manifest') { await audit(db, actor.id, 'backup.manifest', backup.id); return json({ version: 2, backup_id: backup.id, created_at: snapshot.created_at, files: snapshot.tables.attachments.map(file => ({ id: file.id, name: file.name, bytes: file.bytes, mime: file.mime, download_url: `/api/admin/operations/backups/${backup.id}/files/${file.id}` })), file_notice: fileNotice }); }
    if (path.length === 6 && path[4] === 'files') { const file = snapshot.tables.attachments.find(file => file.id === path[5]); if (!file) fail(404, 'NOT_FOUND', '백업 파일을 찾을 수 없습니다.'); await audit(db, actor.id, 'backup.image.download', String(file.id)); const object = await getObject(String(file.storage_key)); return new Response(object.body, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(String(file.name))}`, 'Cache-Control': 'private,no-store', 'X-Content-Type-Options': 'nosniff' } }); }
  }
  if (action === 'restore' && req.method === 'POST' && path.length === 4 && path[3] === 'preview') {
    const data = await input(req, z.object({ backup_id: z.string().uuid() })); const { snapshot } = await storedSnapshot(db, data.backup_id);
    await verifyImageObjects(snapshot.tables.attachments.map(file => String(file.storage_key)));
    await audit(db, actor.id, 'restore.preview', data.backup_id);
    return json({ backup_id: data.backup_id, created_at: snapshot.created_at, counts: Object.fromEntries(Object.entries(snapshot.tables).map(([table, rows]) => [table, rows.length])), confirmation_token: restoreToken(actor.id, data.backup_id, snapshotDigest(snapshot)), message: restoredNotice, file_notice: fileNotice });
  }
  if (action === 'restore' && req.method === 'POST' && path.length === 3) {
    const data = await input(req, z.object({ backup_id: z.string().uuid(), confirmation_token: z.string().max(2000), confirmation: z.literal('닫힌 게시판으로 복원') })); const { snapshot } = await storedSnapshot(db, data.backup_id);
    checkRestoreToken(data.confirmation_token, actor.id, data.backup_id, snapshotDigest(snapshot));
    const runId = await startRun(db, 'restore', actor.id);
    try { await verifyImageObjects(snapshot.tables.attachments.map(file => String(file.storage_key))); await mergeSchoolSnapshot(db, snapshot, actor.id); return json(await finishRun(db, runId, 'completed', restoredNotice)); }
    catch (error) { await finishRun(db, runId, 'failed', '복원을 완료하지 못했습니다. 데이터 변경은 트랜잭션 단위로 취소됩니다.'); throw error; }
  }
  fail(404, 'NOT_FOUND', '운영 메뉴를 찾을 수 없습니다.');
}
