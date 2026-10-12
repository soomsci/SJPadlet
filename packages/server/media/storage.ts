import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { dataPath } from '@server/common/config';
import { setting } from '@server/common/runtime';
import { fail } from '@server/common/http';

function storageUrl(key: string) {
  const base = setting('SUPABASE_URL'), secret = setting('SUPABASE_SECRET_KEY');
  if (!base || !secret || new URL(base).protocol !== 'https:') fail(503, 'STORAGE_NOT_CONFIGURED', '이미지 저장소 설정이 필요합니다.');
  const bucket = setting('SUPABASE_STORAGE_BUCKET') || 'classroom-images';
  const url = `${base.replace(/\/$/, '')}/storage/v1/object/${encodeURIComponent(bucket)}/${encodeURIComponent(key)}`;
  // New sb_secret keys are API keys, not JWTs. Legacy service_role is also supported.
  return { url, headers: { apikey: secret, ...(secret.startsWith('sb_secret_') ? {} : { Authorization: `Bearer ${secret}` }) } };
}
export async function putObject(key: string, data: Buffer, mime: string) {
  if (setting('MEDIA_BACKEND') === 'supabase') {
    const { url, headers } = storageUrl(key);
    const response = await fetch(url, { method: 'POST', headers: { ...headers, 'Content-Type': mime, 'x-upsert': 'false' }, body: new Uint8Array(data), signal: AbortSignal.timeout(15000) });
    if (!response.ok) fail(503, 'STORAGE_UNAVAILABLE', '이미지를 저장하지 못했습니다. 잠시 후 다시 시도해주세요.');
    return;
  }
  const root = dataPath(setting('UPLOAD_PATH') || '.data/uploads');
  await mkdir(root, { recursive: true });
  await writeFile(join(root, key), data, { mode: 0o600 });
}
export async function getObject(key: string): Promise<Response> {
  if (setting('MEDIA_BACKEND') === 'supabase') {
    const { url, headers } = storageUrl(key);
    const response = await fetch(url.replace('/storage/v1/object/', '/storage/v1/object/authenticated/'), { headers, signal: AbortSignal.timeout(15000) });
    if (!response.ok) fail(response.status === 404 ? 404 : 503, 'STORAGE_UNAVAILABLE', '이미지를 불러오지 못했습니다.');
    return response;
  }
  return new Response(new Uint8Array(await readFile(join(dataPath(setting('UPLOAD_PATH') || '.data/uploads'), key))));
}
export async function deleteObject(key: string) {
  if (setting('MEDIA_BACKEND') === 'supabase') {
    const { url, headers } = storageUrl(key);
    const response = await fetch(url, { method: 'DELETE', headers, signal: AbortSignal.timeout(15000) });
    if (!response.ok && response.status !== 404) throw new Error('Storage cleanup failed');
    return;
  }
  await unlink(join(dataPath(setting('UPLOAD_PATH') || '.data/uploads'), key));
}
