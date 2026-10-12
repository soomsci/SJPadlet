import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { generateKeyPair, exportJWK, jwtVerify } from 'jose';
import { getDb, id, now, type Database } from '@db';
import type { BoardView, ShareResult } from '@contracts';
import { dispatch } from '@server/dispatch';
import { validateFile } from '@server/media';
import { withRequestContext, setting } from '@server/common/runtime';
import { getDb as workerDb } from '../../packages/db/worker';
import { getObject } from '@server/media/storage';

let teacherCookie: string, teacherId: string;
const png = (length = 32) => { const data = Buffer.alloc(length); Buffer.from([137,80,78,71,13,10,26,10]).copy(data); return data; };
async function call<T>(path: string, body?: unknown, cookie = teacherCookie, method = body === undefined ? 'GET' : 'POST') {
  const response = await dispatch(new Request('http://localhost:3000/api/' + path, { method, headers: { origin: 'http://localhost:3000', cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }), path.split('/'));
  const result = await response.json();
  return { response, data: result.data as T };
}
async function openBoard() {
  const result = await call<BoardView>('boards', { title: '무료 수업', format: 'wall' });
  return (await call<BoardView>('boards/' + result.data.board.id, { version: result.data.board.version, state: 'open' }, teacherCookie, 'PATCH')).data;
}
async function upload(board: string, cookie = teacherCookie, data = png()) {
  const form = new FormData(); form.set('file', new File([data], 'photo.png', { type: 'image/png' }));
  return dispatch(new Request(`http://localhost:3000/api/boards/${board}/attachments`, { method: 'POST', headers: { origin: 'http://localhost:3000', cookie }, body: form }), ['boards', board, 'attachments']);
}
function free() { vi.stubEnv('FREE_TIER_MODE', 'true'); vi.stubEnv('MEDIA_BACKEND', 'supabase'); vi.stubEnv('SUPABASE_URL', 'https://school.supabase.co'); vi.stubEnv('SUPABASE_SECRET_KEY', 'sb_secret_test_server_only'); }
beforeAll(async () => {
  const db = await getDb(), token = randomBytes(32).toString('base64url'); teacherId = id();
  await db.run("INSERT INTO principals(id,role,display_name,email,created_at) VALUES($1,'teacher','무료 선생님','free@samjeong.ms.kr',$2)", [teacherId, now()]);
  await db.run('INSERT INTO sessions(id,principal_id,token_hash,expires_at,created_at) VALUES($1,$2,$3,$4,$5)', [id(), teacherId, createHash('sha256').update(token).digest('hex'), new Date(Date.now()+3600000).toISOString(), now()]);
  teacherCookie = 'samjeong_session=' + token;
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('free hosting permission and storage boundaries', () => {
  it('rejects large JSON bodies without relying on Content-Length', async () => {
    free(); expect((await call('boards', {title:'교실', extra:'x'.repeat(128*1024)})).response.status).toBe(413);
  });
  it('rejects documents, active formats and images over 1MB without treating them as scanned', () => {
    free(); expect(validateFile('photo.png', png())).toBe('image/png');
    for (const name of ['notes.txt', 'slides.pdf', 'vector.svg', 'animation.gif']) expect(() => validateFile(name, Buffer.from('hello'))).toThrow();
    expect(() => validateFile('photo.png', png(1024 ** 2 + 1))).toThrow();
    expect(() => validateFile('photo.png', Buffer.from('<html>'))).toThrow();
  });
  it('stores privately, proxies only authorized downloads and checks revocation before Storage fetch', async () => {
    free();
    const objects = new Map<string, Uint8Array>();
    const storage = vi.fn(async (url: string, init: RequestInit) => {
      expect(init.headers).toHaveProperty('apikey', 'sb_secret_test_server_only');
      if (init.method === 'POST') { objects.set(url, init.body as Uint8Array); return new Response('{}'); }
      const key = url.replace('/object/authenticated/', '/object/');
      return new Response(objects.has(key) ? new Uint8Array(objects.get(key)!) : null, { status: objects.has(key) ? 200 : 404 });
    });
    vi.stubGlobal('fetch', storage);
    const board = await openBoard();
    const invite = (await call<ShareResult>('shares', { board_id: board.board.id, target_type: 'board', target_id: board.board.id, scope: 'write', expires_hours: 1 })).data;
    const joined = await call('join', { code: invite.code, mode: 'anonymous' }, '');
    const student = joined.response.headers.get('set-cookie')!.split(';')[0];
    const uploaded = await upload(board.board.id, student); expect(uploaded.status).toBe(201);
    const file = (await uploaded.json()).data;
    expect(file).not.toHaveProperty('storage_key'); expect(file).not.toHaveProperty('url');
    const response = await dispatch(new Request('http://localhost:3000/api/file', { headers: { cookie: student } }), ['attachments', file.id, 'content']);
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect((await response.arrayBuffer()).byteLength).toBe(32);
    await call(`shares/${invite.id}/revoke`, {});
    const count = storage.mock.calls.length;
    expect((await dispatch(new Request('http://localhost:3000/api/file', { headers: { cookie: student } }), ['attachments', file.id, 'content'])).status).toBe(404);
    expect(storage).toHaveBeenCalledTimes(count);
  });
  it('serializes the school budget across different boards and performs no rejected object upload', async () => {
    free();
    const storage = vi.fn(async () => new Response('{}')); vi.stubGlobal('fetch', storage);
    const a = await openBoard(), b = await openBoard(), other = await openBoard(), db = await getDb();
    // Use a different owner so the global budget, rather than teacher budget, binds.
    const otherOwner = id();
    await db.run("INSERT INTO principals(id,role,display_name,created_at) VALUES($1,'teacher','다른 교사',$2)", [otherOwner, now()]);
    await db.run('UPDATE boards SET owner_id=$1 WHERE id=$2', [otherOwner, other.board.id]);
    const previous = await db.one<{ bytes: string }>('SELECT COALESCE(sum(bytes),0)::text AS bytes FROM attachments');
    const synthetic = id();
    await db.run("INSERT INTO attachments(id,board_id,uploader_id,name,mime,bytes,storage_key,status,created_at) VALUES($1,$2,$3,'quota.png','image/png',$4,$5,'ready',$6)", [synthetic, other.board.id, otherOwner, 800*1024**2 - 900000 - Number(previous?.bytes), id(), now()]);
    try {
      const results = await Promise.all([upload(a.board.id, teacherCookie, png(600000)), upload(b.board.id, teacherCookie, png(600000))]);
      expect(results.map(r => r.status).sort()).toEqual([201, 413]); expect(storage).toHaveBeenCalledTimes(1);
    } finally { await db.run('DELETE FROM attachments WHERE id=$1', [synthetic]); }
  });
  it('uses authenticated Storage URLs and keeps API secrets server side', async () => {
    free(); const fetcher = vi.fn(async (_url: string) => new Response('image')); vi.stubGlobal('fetch', fetcher);
    await getObject('safe-key');
    expect(fetcher.mock.calls[0][0]).toBe('https://school.supabase.co/storage/v1/object/authenticated/classroom-images/safe-key');
  });
  it('rolls back metadata when the object store fails', async () => {
    free(); const board = await openBoard(); vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })));
    expect((await upload(board.board.id)).status).toBe(503);
    expect(await (await getDb()).all('SELECT * FROM attachments WHERE board_id=$1', [board.board.id])).toHaveLength(0);
  });
  it('issues a short board-specific Realtime capability only after access checks', async () => {
    free(); const pair = await generateKeyPair('ES256', { extractable: true });
    const jwk = { ...await exportJWK(pair.privateKey), kid: id() };
    vi.stubEnv('SUPABASE_SIGNING_JWK', JSON.stringify(jwk)); vi.stubEnv('SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_test');
    const board = await openBoard();
    const result = await call<{ token: string; expires_in: number; topic: string }>(`boards/${board.board.id}/realtime-ticket`);
    expect(result.response.status).toBe(200);
    const { payload } = await jwtVerify(result.data.token, pair.publicKey, { audience: 'authenticated' });
    expect(payload.moa_topic).toBe(`moa:board:${board.board.id}`); expect(payload.moa_capability).toBe('realtime-only');
    expect(payload.exp! - payload.iat!).toBe(60); expect(payload).not.toHaveProperty('email'); expect(payload).not.toHaveProperty('board');
    expect((await call(`boards/${board.board.id}/realtime-ticket`, undefined, '')).response.status).toBe(401);
    expect((await call(`boards/${board.board.id}/events`)).response.status).toBe(410);
    const invitation = (await call<ShareResult>('shares', { board_id: board.board.id, target_type: 'submission', target_id: board.board.id, scope: 'write', expires_hours: 1 })).data;
    const join = await call('join', { code: invitation.code, mode: 'anonymous' }, ''); const student = join.response.headers.get('set-cookie')!.split(';')[0];
    expect((await call(`boards/${board.board.id}/realtime-ticket`, undefined, student)).response.status).toBe(200);
    await call(`shares/${invitation.id}/revoke`, {});
    expect((await call(`boards/${board.board.id}/realtime-ticket`, undefined, student)).response.status).toBe(404);
  });
});

describe('Worker request isolation', () => {
  it('keeps overlapping account settings and database connections separate', async () => {
    const databaseA: Database = { ...await getDb() }, databaseB: Database = { ...await getDb() };
    const values = await Promise.all([databaseA, databaseB].map((database, index) => withRequestContext({ values: { APP_URL: String(index) }, database: async () => database }, async () => {
      await new Promise(resolve => setTimeout(resolve, index ? 1 : 5));
      return [setting('APP_URL'), await workerDb()];
    })));
    expect(values).toEqual([['0', databaseA], ['1', databaseB]]);
    expect(setting('APP_URL')).toBe('http://localhost:3000'); expect(() => workerDb()).toThrow();
  });
});
