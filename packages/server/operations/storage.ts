import { setting } from '@server/common/runtime';
import { fail } from '@server/common/http';

export const BACKUP_BUCKET = 'school-backups';
export const BACKUP_MAX_BYTES = 10 * 1024 ** 2;
export const BACKUP_BUDGET_BYTES = 100 * 1024 ** 2;
export const BACKUP_RETENTION_DAYS = 7;
export function storageConfiguration(bucket = BACKUP_BUCKET) {
  const base = setting('SUPABASE_URL'), secret = setting('SUPABASE_SECRET_KEY');
  if (!base || !secret || new URL(base).protocol !== 'https:') fail(503, 'BACKUP_NOT_CONFIGURED', '비공개 백업 저장소 설정이 필요합니다.');
  return { base: base.replace(/\/$/, ''), bucket, headers: { apikey: secret, ...(secret.startsWith('sb_secret_') ? {} : { Authorization: `Bearer ${secret}` }) } };
}
function objectPath(bucket: string, key: string) { return `${encodeURIComponent(bucket)}/${encodeURIComponent(key)}`; }
export async function saveBackupObject(key: string, value: Uint8Array) {
  const { base, bucket, headers } = storageConfiguration();
  const response = await fetch(`${base}/storage/v1/object/${objectPath(bucket, key)}`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/octet-stream', 'x-upsert': 'false' }, body: value as BodyInit, signal: AbortSignal.timeout(30000) });
  if (!response.ok) fail(503, 'BACKUP_STORAGE_UNAVAILABLE', '백업을 저장하지 못했습니다.');
}
export async function readBackupObject(key: string) {
  const { base, bucket, headers } = storageConfiguration();
  const response = await fetch(`${base}/storage/v1/object/authenticated/${objectPath(bucket, key)}`, { headers, signal: AbortSignal.timeout(30000) });
  if (!response.ok) fail(503, 'BACKUP_STORAGE_UNAVAILABLE', '백업을 불러오지 못했습니다.');
  if (Number(response.headers.get('content-length')) > BACKUP_MAX_BYTES + 64) fail(413, 'BACKUP_TOO_LARGE', '백업 크기를 확인해주세요.');
  const reader = response.body?.getReader(); if (!reader) fail(503, 'BACKUP_STORAGE_UNAVAILABLE', '백업을 불러오지 못했습니다.');
  const chunks: Uint8Array[] = []; let size = 0;
  for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength; if (size > BACKUP_MAX_BYTES + 64) { await reader.cancel(); fail(413, 'BACKUP_TOO_LARGE', '백업 크기를 확인해주세요.'); } chunks.push(value); }
  return new Uint8Array(Buffer.concat(chunks));
}
export async function removeBackupObject(key: string) {
  const { base, bucket, headers } = storageConfiguration();
  const response = await fetch(`${base}/storage/v1/object/${objectPath(bucket, key)}`, { method: 'DELETE', headers, signal: AbortSignal.timeout(15000) });
  if (!response.ok && response.status !== 404) fail(503, 'BACKUP_STORAGE_UNAVAILABLE', '오래된 백업을 정리하지 못했습니다.');
}
export async function verifyImageObjects(keys: string[]) {
  if (!keys.length) return;
  const { base, bucket, headers } = storageConfiguration(setting('SUPABASE_STORAGE_BUCKET') || 'classroom-images');
  const remaining = new Set(keys);
  // Flat, immutable keys are used by the upload service. Bulk listing avoids
  // one HEAD request per image and does not download image contents.
  for (let offset = 0; ; offset += 1000) {
    const response = await fetch(`${base}/storage/v1/object/list/${encodeURIComponent(bucket)}`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ prefix: '', limit: 1000, offset, sortBy: { column: 'name', order: 'asc' } }), signal: AbortSignal.timeout(15000) });
    if (!response.ok) fail(503, 'BACKUP_STORAGE_UNAVAILABLE', '복원할 이미지 파일을 확인하지 못했습니다.');
    const objects = await response.json() as { name: string }[];
    if (!Array.isArray(objects)) fail(503, 'BACKUP_STORAGE_UNAVAILABLE', '이미지 목록을 확인하지 못했습니다.');
    for (const object of objects) remaining.delete(object.name);
    if (!remaining.size) return;
    if (objects.length < 1000) break;
  }
  fail(409, 'BACKUP_FILES_MISSING', `백업에 기록된 이미지 ${remaining.size}개가 없습니다. 파일을 먼저 복구해주세요.`);
}
