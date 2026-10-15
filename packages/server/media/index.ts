import { createConnection } from 'node:net';
import { randomBytes } from 'node:crypto';
import { basename } from 'node:path';
import { getDb, id, now, audit } from '@db';
import type { Attachment, Post } from '@contracts';
import { requirePrincipal } from '@server/auth';
import { boardAccess, canReadPost } from '@server/policy';
import { setting } from '@server/common/runtime';
import { fail, json } from '@server/common/http';
import { uploadPolicy } from './policy';
import { putObject, getObject, deleteObject } from './storage';

const types: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' };
export function validateFile(name: string, data: Buffer) {
  const policy = uploadPolicy();
  const ext = name.split('.').pop()?.toLowerCase() || '', mime = types[ext];
  if (!mime || !data.length || data.length > policy.maxBytes || (policy.imagesOnly && !['png', 'jpg', 'jpeg', 'webp'].includes(ext))) {
    fail(400, 'UPLOAD_REJECTED', policy.imagesOnly ? '1MB 이하의 JPG, PNG, WebP 이미지를 선택해주세요. 문서와 동영상은 링크로 공유할 수 있어요.' : '20MB 이하의 이미지, PDF, 문서, 텍스트 파일을 선택해주세요.');
  }
  let valid = true;
  if (ext === 'png') valid = data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (['jpg', 'jpeg'].includes(ext)) valid = data[0] === 255 && data[1] === 216 && data[2] === 255;
  if (ext === 'gif') valid = /^GIF8[79]a/.test(data.subarray(0, 6).toString());
  if (ext === 'webp') valid = data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP';
  if (ext === 'pdf') valid = data.subarray(0, 5).toString() === '%PDF-';
  if (['docx', 'xlsx', 'pptx'].includes(ext)) valid = data.subarray(0, 2).toString() === 'PK';
  if (['txt', 'csv'].includes(ext)) valid = !data.includes(0) && !/<(?:script|html|svg|iframe)\b/i.test(data.toString('utf8'));
  if (!valid) fail(400, 'UPLOAD_REJECTED', '파일의 형식과 확장자가 일치하지 않습니다.');
  return mime;
}
async function scan(data: Buffer): Promise<'ready' | 'quarantined' | 'rejected'> {
  const host = setting('CLAMAV_HOST');
  // Free deployments accept raster images only. This is format validation,
  // explicitly not an antivirus scan. General documents still require ClamAV.
  if (uploadPolicy().imagesOnly) return 'ready';
  if (!host) return setting('NODE_ENV') === 'production' ? 'quarantined' : 'ready';
  return new Promise(resolve => {
    const socket = createConnection({ host, port: Number(setting('CLAMAV_PORT') || 3310) });
    let result = '';
    socket.setTimeout(15000);
    socket.on('connect', () => {
      socket.write('zINSTREAM\0');
      for (let offset = 0; offset < data.length; offset += 65536) {
        const chunk = data.subarray(offset, offset + 65536), header = Buffer.alloc(4);
        header.writeUInt32BE(chunk.length); socket.write(header); socket.write(chunk);
      }
      socket.write(Buffer.alloc(4));
    });
    socket.on('data', chunk => { result += chunk.toString(); if (result.includes('\0')) socket.end(); });
    socket.on('end', () => resolve(result.includes('FOUND') ? 'rejected' : result.includes('OK') ? 'ready' : 'quarantined'));
    socket.on('error', () => resolve('quarantined'));
    socket.on('timeout', () => { socket.destroy(); resolve('quarantined'); });
  });
}
export async function handleMedia(req: Request, path: string[]): Promise<Response | null> {
  if (req.method === 'POST' && path[0] === 'boards' && path[2] === 'attachments' && path.length === 3) {
    const principal = await requirePrincipal(req), db = await getDb(), policy = uploadPolicy();
    const access = await boardAccess(db, principal, path[1]);
    if (!access.can_write) fail(403, 'FORBIDDEN', '파일을 올릴 수 없습니다.');
    const bodyLimit = policy.maxBytes + 64 * 1024;
    if (Number(req.headers.get('content-length') || 0) > bodyLimit) fail(413, 'UPLOAD_REJECTED', '첨부할 수 있는 크기를 초과했습니다.');
    const reader = req.body?.getReader();
    if (!reader) fail(400, 'UPLOAD_REJECTED', '파일을 선택해주세요.');
    const chunks: Uint8Array[] = []; let total = 0;
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      total += value.byteLength;
      if (total > bodyLimit) { await reader.cancel(); fail(413, 'UPLOAD_REJECTED', '첨부할 수 있는 크기를 초과했습니다.'); }
      chunks.push(value);
    }
    const form = await new Response(Buffer.concat(chunks), { headers: { 'content-type': req.headers.get('content-type') || '' } }).formData();
    const file = form.get('file');
    if (!(file instanceof File)) fail(400, 'UPLOAD_REJECTED', '파일을 선택해주세요.');
    const data = Buffer.from(await file.arrayBuffer()), mime = validateFile(file.name, data), status = await scan(data);
    if (status === 'rejected') fail(400, 'UPLOAD_REJECTED', '안전하지 않은 파일이 감지되었습니다.');
    const attachment: Attachment = { id: id(), board_id: path[1], post_id: null, uploader_id: principal.id, name: basename(file.name).slice(0, 200), mime, bytes: data.length, storage_key: randomBytes(24).toString('hex'), status, created_at: now() };
    let reserved = false;
    try {
      await db.transaction(async tx => {
        // Serialize the school-wide budget check, including uploads to different
        // teachers' boards. Store only after all quotas and permissions pass.
        if (policy.schoolBytes !== null) {
          if (!await tx.one('SELECT id FROM storage_budget WHERE id=1 FOR UPDATE')) fail(503, 'STORAGE_NOT_CONFIGURED', '저장 용량 설정이 필요합니다.');
          const school = await tx.one<{ bytes: string }>('SELECT COALESCE(SUM(bytes),0)::text AS bytes FROM attachments');
          if (Number(school?.bytes) + data.length > policy.schoolBytes) fail(413, 'UPLOAD_REJECTED', '학교 저장 공간이 가득 찼습니다. 선생님께 알려주세요.');
        }
        await tx.run('SELECT id FROM boards WHERE id=$1 FOR UPDATE', [path[1]]);
        const fresh = await boardAccess(tx, principal, path[1]);
        await tx.run('SELECT id FROM principals WHERE id=$1 FOR UPDATE', [fresh.board.owner_id]);
        if (!fresh.can_write) fail(403, 'FORBIDDEN', '참여가 종료되었습니다.');
        const usage = await tx.one<{ bytes: string }>('SELECT COALESCE(SUM(bytes),0) AS bytes FROM attachments WHERE board_id=$1', [path[1]]);
        if (Number(usage?.bytes) + data.length > policy.boardBytes) fail(413, 'UPLOAD_REJECTED', '게시판 저장 공간이 가득 찼습니다.');
        const ownerUsage = await tx.one<{ bytes: string }>('SELECT COALESCE(SUM(a.bytes),0) AS bytes FROM attachments a JOIN boards b ON b.id=a.board_id WHERE b.owner_id=$1', [fresh.board.owner_id]);
        if (Number(ownerUsage?.bytes) + data.length > policy.teacherBytes) fail(413, 'UPLOAD_REJECTED', '교사 저장 공간이 가득 찼습니다.');
        // Reserve the bytes as a non-downloadable row; the Storage call happens after the budget lock is released
        // so a class uploading at once does not queue behind each other's HTTP uploads.
        await tx.run('INSERT INTO attachments(id,board_id,post_id,uploader_id,name,mime,bytes,storage_key,status,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', Object.values({ ...attachment, status: 'quarantined' }));
        await audit(tx, principal.id, 'attachment.upload', attachment.id);
      });
      reserved = true;
      await putObject(attachment.storage_key, data, mime);
      if (status !== 'quarantined') await db.run('UPDATE attachments SET status=$2 WHERE id=$1', [attachment.id, status]);
    } catch (error) {
      if (reserved) {
        await deleteObject(attachment.storage_key).catch(() => { console.error(JSON.stringify({ code: 'STORAGE_CLEANUP_FAILED', attachment_id: attachment.id })); });
        await db.run('DELETE FROM attachments WHERE id=$1', [attachment.id]).catch(() => { console.error(JSON.stringify({ code: 'RESERVATION_CLEANUP_FAILED', attachment_id: attachment.id })); });
      }
      throw error;
    }
    return json({ id: attachment.id, name: attachment.name, mime, bytes: data.length, status }, 201);
  }
  if (req.method === 'GET' && path[0] === 'attachments' && path[2] === 'content' && path.length === 3) {
    const principal = await requirePrincipal(req), db = await getDb();
    const file = await db.one<Attachment>('SELECT * FROM attachments WHERE id=$1', [path[1]]);
    if (!file) fail(404, 'NOT_FOUND', '파일을 찾을 수 없습니다.');
    const access = await boardAccess(db, principal, file.board_id);
    if (file.status !== 'ready') fail(403, 'UPLOAD_REJECTED', '열 수 없는 파일입니다.');
    if (file.post_id) {
      const post = await db.one<Post>('SELECT * FROM posts WHERE id=$1', [file.post_id]);
      if (!post || !canReadPost(access, principal, post)) fail(404, 'NOT_FOUND', '파일을 찾을 수 없습니다.');
    } else if (file.uploader_id !== principal.id && !access.can_manage) fail(404, 'NOT_FOUND', '파일을 찾을 수 없습니다.');
    const object = await getObject(file.storage_key);
    const disposition = file.mime.startsWith('image/') ? 'inline' : 'attachment';
    // Each upload gets a fresh storage key, so the bytes behind this URL never change. The viewer's browser may keep them a
    // day instead of re-downloading through Worker + Supabase egress on every board open. Access is still checked on every
    // fetch; like any downloaded content, a copy already cached on a device is not recalled by a later revoke (PRD 7).
    return new Response(object.body, { headers: { 'Content-Type': file.mime, 'Content-Length': String(file.bytes), 'Content-Disposition': `${disposition}; filename*=UTF-8''${encodeURIComponent(file.name)}`, 'Cache-Control': 'private, max-age=86400, immutable', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" } });
  }
  return null;
}
