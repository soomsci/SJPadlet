/** Off-site encrypted image archive. No export or remote writes unless --apply.
 * Required: BACKUP_ENCRYPTION_KEY, APP_URL, MOA_SESSION_COOKIE (admin session).
 * Image recovery requires SUPABASE_URL/SUPABASE_SECRET_KEY and explicit confirm.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { z } from 'zod';
import { pathToFileURL } from 'node:url';
import { Client } from 'pg';
import { decryptBytes, encryptBytes, openSnapshot } from '../packages/server/operations/snapshot';
import { storageConfiguration } from '../packages/server/operations/storage';

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const bundleSchema = z.object({ version: z.literal(1), database_sha256: z.string().regex(/^[a-f0-9]{64}$/), files: z.array(z.object({ attachment_id: z.string().uuid(), encrypted_sha256: z.string().regex(/^[a-f0-9]{64}$/), content_sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().min(1).max(1024 ** 2) }).strict()).max(10000) }).strict();
async function boundedBody(response: Response, max: number) { if (!response.ok) throw new Error('권한 또는 저장소 응답을 확인해주세요.'); const reader = response.body?.getReader(); if (!reader) throw new Error('파일을 읽지 못했습니다.'); const chunks: Uint8Array[] = []; let size = 0; for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > max) { await reader.cancel(); throw new Error('파일 한도를 초과했습니다.'); } chunks.push(value); } return Buffer.concat(chunks); }
async function apiFile(path: string, max: number) { const app = process.env.APP_URL, cookie = process.env.MOA_SESSION_COOKIE; if (!app || !cookie || new URL(app).protocol !== 'https:') throw new Error('APP_URL 및 관리자 MOA_SESSION_COOKIE가 필요합니다. 비밀값을 출력하거나 커밋하지 마세요.'); return boundedBody(await fetch(new URL(path, app), { headers: { cookie }, signal: AbortSignal.timeout(30000), redirect: 'error' }), max); }
export async function runArchive(argumentsList: string[]) {
  const command = argumentsList[0];
  const option = (name: string) => { const index = argumentsList.indexOf('--' + name); return index >= 0 ? argumentsList[index + 1] : undefined; };
  const apply = argumentsList.includes('--apply');
  const directory = option('out') || option('dir');
  if (!directory || !['export', 'restore-files'].includes(command || '')) throw new Error('사용법: export --backup UUID --out 폴더 [--apply] 또는 restore-files --dir 폴더 [--apply --confirm "이미지 원본 복구"]');
  const root = resolve(directory);
  if (command === 'export') {
    const backupId = z.string().uuid().parse(option('backup'));
    const encrypted = await apiFile(`/api/admin/operations/backups/${backupId}/download`, 10 * 1024 ** 2 + 36);
    const snapshot = openSnapshot(encrypted);
    const total = snapshot.tables.attachments.reduce((sum, file) => sum + Number(file.bytes), 0);
    if (total > 800 * 1024 ** 2 || snapshot.tables.attachments.some(file => Number(file.bytes) > 1024 ** 2)) throw new Error('무료 이미지 묶음 한도를 초과했습니다.');
    console.log(JSON.stringify({ action: 'export', dry_run: !apply, images: snapshot.tables.attachments.length, image_bytes: total, encrypted_database_bytes: encrypted.length }));
    if (!apply) return;
    if (existsSync(root)) throw new Error('이미 존재하는 폴더에 덮어쓰지 않습니다. 새 출력 폴더를 지정해주세요.');
    await mkdir(root, { recursive: true, mode: 0o700 }); await mkdir(join(root, 'files'), { mode: 0o700 }); await writeFile(join(root, 'database.sjbackup'), encrypted, { mode: 0o600, flag: 'wx' });
    const files: z.infer<typeof bundleSchema>['files'] = [];
    for (const attachment of snapshot.tables.attachments) {
      const attachmentId = z.string().uuid().parse(attachment.id);
      const body = await apiFile(`/api/admin/operations/backups/${backupId}/files/${attachmentId}`, 1024 ** 2);
      if (body.length !== Number(attachment.bytes)) throw new Error('이미지 크기가 백업 기록과 다릅니다.');
      const protectedFile = encryptBytes(body); await writeFile(join(root, 'files', attachmentId + '.sjfile'), protectedFile, { mode: 0o600, flag: 'wx' }); files.push({ attachment_id: attachmentId, encrypted_sha256: hash(protectedFile), content_sha256: hash(body), bytes: body.length });
    }
    await writeFile(join(root, 'manifest.sjmanifest'), encryptBytes(Buffer.from(JSON.stringify({ version: 1, database_sha256: hash(encrypted), files }))), { mode: 0o600, flag: 'wx' });
    console.log('암호화 데이터와 모든 이미지 저장 완료. 이 폴더와 암호화 키를 서로 다른 안전한 위치에 보관하세요.'); return;
  }
  const encrypted = await readFile(join(root, 'database.sjbackup'));
  const manifest = bundleSchema.parse(JSON.parse(decryptBytes(await readFile(join(root, 'manifest.sjmanifest'))).toString('utf8')));
  if (hash(encrypted) !== manifest.database_sha256) throw new Error('데이터 파일 체크섬이 일치하지 않습니다.');
  const snapshot = openSnapshot(encrypted), fileMap = new Map(manifest.files.map(file => [file.attachment_id, file]));
  if (fileMap.size !== manifest.files.length || fileMap.size !== snapshot.tables.attachments.length || manifest.files.reduce((sum, file) => sum + file.bytes, 0) > 800 * 1024 ** 2) throw new Error('이미지 묶음 구성이 올바르지 않습니다.');
  for (const file of snapshot.tables.attachments) { const fileId = z.string().uuid().parse(file.id), expected = fileMap.get(fileId); if (!expected || expected.bytes !== file.bytes || !/^[a-f0-9]{48}$/.test(String(file.storage_key))) throw new Error('이미지 식별자가 올바르지 않습니다.'); const encryptedImage = await readFile(join(root, 'files', fileId + '.sjfile')); if (encryptedImage.length > 1024 ** 2 + 36 || hash(encryptedImage) !== expected.encrypted_sha256) throw new Error('이미지 체크섬이 일치하지 않습니다.'); const body = decryptBytes(encryptedImage); if (body.length !== expected.bytes || hash(body) !== expected.content_sha256) throw new Error('이미지 무결성이 일치하지 않습니다.'); }
  console.log(JSON.stringify({ action: 'restore-files', dry_run: !apply, verified_images: fileMap.size, database_restore: false }));
  if (!apply) return;
  if (option('confirm') !== '이미지 원본 복구') throw new Error('이미지 업로드에는 --confirm "이미지 원본 복구"가 필요합니다.');
  const storage = storageConfiguration(process.env.SUPABASE_STORAGE_BUCKET || 'classroom-images');
  if (!process.env.DATABASE_URL) throw new Error('이미지 복구 용량을 잠그려면 DATABASE_URL이 필요합니다.');
  const database = new Client({ connectionString: process.env.DATABASE_URL }); await database.connect();
  try {
    await database.query('BEGIN');
    await database.query('SELECT id FROM storage_budget WHERE id=1 FOR UPDATE');
    if ((await database.query("SELECT id FROM operation_runs WHERE status='running' LIMIT 1")).rowCount) throw new Error('다른 운영 작업이 진행 중입니다.');
    const storedNames = new Set<string>(); let existingBytes = 0;
    for (let offset = 0; ; offset += 1000) {
      const response = await fetch(`${storage.base}/storage/v1/object/list/${encodeURIComponent(storage.bucket)}`, { method: 'POST', headers: { ...storage.headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ prefix: '', limit: 1000, offset, sortBy: { column: 'name', order: 'asc' } }), signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error('현재 저장 용량을 확인하지 못했습니다.');
      const entries = z.array(z.object({ name: z.string(), metadata: z.object({ size: z.number().nonnegative() }) })).parse(await response.json());
      for (const entry of entries) { storedNames.add(entry.name); existingBytes += entry.metadata.size; }
      if (entries.length < 1000) break;
    }
    const additionalBytes = snapshot.tables.attachments.filter(file => !storedNames.has(String(file.storage_key))).reduce((sum, file) => sum + Number(file.bytes), 0);
    if (existingBytes + additionalBytes > 800 * 1024 ** 2) throw new Error('복구 후 이미지 저장량이 학교 800MB 한도를 초과합니다.');
  for (const file of snapshot.tables.attachments) {
    const base = `${storage.base}/storage/v1/object/`, path = `${encodeURIComponent(storage.bucket)}/${encodeURIComponent(String(file.storage_key))}`;
    const existing = await fetch(base + 'authenticated/' + path, { headers: storage.headers, signal: AbortSignal.timeout(15000) });
    if (existing.ok) { const bytes = await boundedBody(existing, 1024 ** 2); if (hash(bytes) !== fileMap.get(String(file.id))!.content_sha256) throw new Error('기존 이미지가 묶음과 다릅니다. 기존 원본은 덮어쓰지 않습니다.'); continue; }
    if (existing.status !== 404 && existing.status !== 400) throw new Error('원본 이미지 존재 여부를 확인하지 못했습니다.');
    // A 400 can mean a malformed request rather than a missing object; never
    // attempt writes unless Storage explicitly identifies a missing object.
    if (existing.status === 400) { const detail = await existing.json() as { statusCode?: string; error?: string }; if (detail.statusCode !== '404' && detail.error !== 'not_found') throw new Error('저장소의 파일 없음 응답을 확인하지 못했습니다.'); }
    const body = decryptBytes(await readFile(join(root, 'files', String(file.id) + '.sjfile')));
    const response = await fetch(base + path, { method: 'POST', headers: { ...storage.headers, 'Content-Type': String(file.mime), 'x-upsert': 'false' }, body: new Uint8Array(body), signal: AbortSignal.timeout(30000) }); if (!response.ok) throw new Error('이미지 복구를 중단했습니다. 다시 실행하면 기존 원본을 건너뜁니다.');
  }
  await database.query('COMMIT');
  } catch (error) { await database.query('ROLLBACK'); throw error; } finally { await database.end(); }
  console.log('이미지 원본 복구 완료. 데이터는 학교 관리의 복원 전 확인 화면에서 검토 후 복원해주세요.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (existsSync('.env.free')) process.loadEnvFile('.env.free');
  void runArchive(process.argv.slice(2)).catch(() => { console.error('파일 묶음 작업이 중단되었습니다. 인수·관리자 세션·전용 키·파일 무결성·저장소를 확인해주세요. 비밀값은 출력하지 않습니다.'); process.exitCode = 1; });
}
