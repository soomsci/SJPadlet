import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { getDb, id, now, type Database } from '@db';
import type { OperationRun } from '@contracts';
import { handleOperations, cleanupCandidates, performBackup, performCleanup, runMaintenance } from '@server/operations';
import { encryptBytes, openSnapshot, schoolSnapshot, mergeSchoolSnapshot, restoreToken, checkRestoreToken, snapshotDigest } from '@server/operations/snapshot';
import { errorResponse } from '@server/common/http';

let db: Database, admin: string, teacher: string, student: string, board: string, post: string, attachment: string, key: string;
const cookies: Record<string, string> = {}, objects = new Map<string, Uint8Array>();
const env = ['BACKUP_ENCRYPTION_KEY', 'SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'MEDIA_BACKEND'].map(name => [name, process.env[name]] as const);
const mockFetch = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(request)); expect(url.host).toBe('school.supabase.co');
  const headers = new Headers(init?.headers); expect(headers.get('apikey')).toBe('sb_secret_test_only'); expect(headers.has('Authorization')).toBe(false);
  const path = url.pathname.replace('/storage/v1/object/', '');
  if (path.startsWith('list/')) { const bucket = path.slice(5), { offset, limit } = JSON.parse(String(init?.body)); return Response.json([...objects.keys()].filter(key => key.startsWith(bucket + '/')).map(key => ({ name: key.slice(bucket.length + 1) })).sort((a, b) => a.name.localeCompare(b.name)).slice(offset, offset + limit)); }
  const objectKey = path.replace(/^authenticated\//, '');
  if (init?.method === 'POST') { expect(headers.get('x-upsert')).toBe('false'); expect(objects.has(objectKey)).toBe(false); objects.set(objectKey, new Uint8Array(init.body as Uint8Array)); return Response.json({ Key: objectKey }); }
  if (init?.method === 'DELETE') { objects.delete(objectKey); return Response.json({}); }
  const body = objects.get(objectKey); return body ? new Response(new Uint8Array(body), { headers: { 'content-length': String(body.length) } }) : new Response(null, { status: 404 });
});
async function call(path: string, body?: unknown, who = 'admin', method = body === undefined ? 'GET' : 'POST', origin = 'http://localhost:3000') {
  try { return (await handleOperations(new Request('http://localhost:3000/api/admin/operations/' + path, { method, headers: { origin, cookie: cookies[who] || '', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }), ['admin', 'operations', ...path.split('/')]))!; } catch (error) { return errorResponse(error); }
}
beforeAll(async () => {
  process.env.BACKUP_ENCRYPTION_KEY = randomBytes(32).toString('base64url'); process.env.SUPABASE_URL = 'https://school.supabase.co'; process.env.SUPABASE_SECRET_KEY = 'sb_secret_test_only'; process.env.MEDIA_BACKEND = 'supabase'; vi.stubGlobal('fetch', mockFetch);
  db = await getDb();
  for (const role of ['admin', 'teacher', 'student']) { const pid = id(), token = randomBytes(32).toString('base64url'); await db.run('INSERT INTO principals(id,role,display_name,email,created_at) VALUES($1,$2,$3,$4,$5)', [pid, role, '합성 ' + role, role + '@example.test', now()]); await db.run('INSERT INTO sessions(id,principal_id,token_hash,expires_at,created_at) VALUES($1,$2,$3,$4,$5)', [id(), pid, createHash('sha256').update(token).digest('hex'), new Date(Date.now() + 3600000).toISOString(), now()]); cookies[role] = 'samjeong_session=' + token; if (role === 'admin') admin = pid; if (role === 'teacher') teacher = pid; if (role === 'student') student = pid; }
  board = id(); post = id(); attachment = id(); key = randomBytes(24).toString('hex');
  await db.run("INSERT INTO boards(id,owner_id,title,format,state,participation_mode,created_at,updated_at) VALUES($1,$2,'복구할 게시판','columns','open','both',$3,$3)", [board, teacher, now()]);
  await db.run("INSERT INTO posts(id,board_id,author_id,title,body,status,created_at,updated_at) VALUES($1,$2,$3,'승인 전 질문','다른 학생에게 비공개','pending',$4,$4)", [post, board, student, now()]);
  await db.run("INSERT INTO attachments(id,board_id,post_id,uploader_id,name,mime,bytes,storage_key,status,created_at) VALUES($1,$2,$3,$4,'합성.png','image/png',3,$5,'ready',$6)", [attachment, board, post, student, key, now()]); objects.set('classroom-images/' + key, Uint8Array.from([1, 2, 3]));
});
afterAll(() => { for (const [name, value] of env) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } vi.unstubAllGlobals(); });

describe('school operations permissions and encrypted backup', () => {
  it('denies students, teachers, unauthenticated requests and cross-origin mutations before storage access', async () => { for (const who of ['student', 'teacher', 'none']) { const response = await call('backup', {}, who); expect(response.status).toBe(who === 'none' ? 401 : 403); } expect((await call('backup', {}, 'admin', 'POST', 'https://evil.test')).status).toBe(403); expect(mockFetch).not.toHaveBeenCalled(); });
  it('writes private authenticated ciphertext without sessions, identity secrets or historical access grants', async () => {
    const response = await call('backup', {}); expect(response.status).toBe(201); const run = (await response.json()).data as OperationRun;
    const encrypted = objects.get('school-backups/' + run.storage_key)!; expect(Buffer.from(encrypted).toString()).not.toContain('다른 학생에게');
    const snapshot = openSnapshot(encrypted); expect(snapshot.tables.posts[0].status).toBe('pending'); expect(Object.keys(snapshot.tables)).not.toContain('sessions'); expect(snapshot.tables).not.toHaveProperty('oauth_states'); expect(snapshot.tables).not.toHaveProperty('share_links'); expect(snapshot.tables).not.toHaveProperty('participations'); expect(snapshot.tables.principals[0]).not.toHaveProperty('email'); expect(snapshot.tables.principals[0]).not.toHaveProperty('role'); expect(await db.one('SELECT * FROM backup_object_refs WHERE backup_id=$1 AND attachment_id=$2', [run.id, attachment])).toBeTruthy();
    const changed = new Uint8Array(encrypted); changed[changed.length - 1] ^= 1; expect(() => openSnapshot(changed)).toThrow('무결성');
  });
  it('reports actual app storage and database size while distinguishing unmeasured provider usage', async () => { const response = await call('usage'); expect(response.status).toBe(200); const usage = (await response.json()).data; expect(usage.images.bytes).toBe(3); expect(usage.images.limit_bytes).toBe(800 * 1024 ** 2); expect(usage.backups.limit_bytes).toBe(100 * 1024 ** 2); expect(usage.database.bytes).toBeGreaterThan(0); expect(usage.external_usage.measured).toBe(false); });
  it('keeps at most seven snapshots and bounds stored backup bytes', async () => { for (let index = 0; index < 7; index++) await performBackup(db, admin); const runs = await db.all<OperationRun>("SELECT * FROM operation_runs WHERE kind='backup' AND storage_key IS NOT NULL"); expect(runs).toHaveLength(7); expect([...objects.keys()].filter(key => key.startsWith('school-backups/'))).toHaveLength(7); expect(runs.reduce((sum, run) => sum + run.bytes, 0)).toBeLessThan(100 * 1024 ** 2); const refs = await db.all<{ backup_id: string }>('SELECT backup_id FROM backup_object_refs'); expect(refs.every(ref => runs.some(run => run.id === ref.backup_id))).toBe(true); });
  it('does not permit overlapping backup or cleanup tasks', async () => { const running = id(); await db.run("INSERT INTO operation_runs(id,kind,status,created_at) VALUES($1,'backup','running',$2)", [running, now()]); await expect(performBackup(db, admin)).rejects.toThrow('다른 운영 작업'); await expect(performCleanup(db, admin)).rejects.toThrow('다른 운영 작업'); await db.run('DELETE FROM operation_runs WHERE id=$1', [running]); });
});

describe('safe retention and content recovery', () => {
  it('only removes old abandoned known uploads, preserving active drafts, live files and snapshot references', async () => {
    const old = new Date(Date.now() - 35 * 86400000).toISOString();
    async function file(name: string, postId: string | null) { const aid = id(); await db.run("INSERT INTO attachments(id,board_id,post_id,uploader_id,name,mime,bytes,storage_key,status,created_at) VALUES($1,$2,$3,$4,$5,'image/png',4,$6,'ready',$7)", [aid, board, postId, student, name + '.png', name, old]); objects.set('classroom-images/' + name, Uint8Array.from([4, 5, 6, 7])); return aid; }
    const abandoned = await file('abandoned', null), draftFile = await file('draft-protected', null), backed = await file('backup-protected', null);
    await db.run('INSERT INTO post_drafts(id,board_id,principal_id,attachment_ids,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$5)', [id(), board, student, JSON.stringify([draftFile]), now()]);
    const prior = (await db.one<OperationRun>("SELECT * FROM operation_runs WHERE kind='backup' AND storage_key IS NOT NULL LIMIT 1"))!; await db.run('INSERT INTO backup_object_refs(backup_id,attachment_id,storage_key,bytes) VALUES($1,$2,$3,4)', [prior.id, backed, 'backup-protected']);
    objects.set('classroom-images/unknown-object', Uint8Array.from([1]));
    const plan = await cleanupCandidates(db); expect(plan.map(file => file.id)).toEqual([abandoned]); expect((await call('cleanup', { confirmation: 'wrong' })).status).toBe(400);
    const result = await performCleanup(db, admin); expect(result.bytes).toBe(4); expect(await db.one('SELECT id FROM attachments WHERE id=$1', [abandoned])).toBeNull(); expect(objects.has('classroom-images/abandoned')).toBe(false); for (const name of [key, 'draft-protected', 'backup-protected', 'unknown-object']) expect(objects.has('classroom-images/' + name)).toBe(true);
  });
  it('validates administrator-bound, expiring confirmation and checks missing image objects', async () => {
    const run = await performBackup(db, admin); const response = await call('restore/preview', { backup_id: run.id }); expect(response.status).toBe(200); const plan = (await response.json()).data;
    const snapshot = openSnapshot(objects.get('school-backups/' + run.storage_key)!); expect(() => checkRestoreToken(plan.confirmation_token, teacher, run.id, snapshotDigest(snapshot))).toThrow('만료'); expect(() => checkRestoreToken(plan.confirmation_token + 'x', admin, run.id, snapshotDigest(snapshot))).toThrow();
    objects.delete('classroom-images/' + key); expect((await call('restore/preview', { backup_id: run.id })).status).toBe(409); objects.set('classroom-images/' + key, Uint8Array.from([1, 2, 3]));
    const bad = restoreToken(admin, run.id, 'wrong-digest'); expect((await call('restore', { backup_id: run.id, confirmation: '닫힌 게시판으로 복원', confirmation_token: bad })).status).toBe(400);
  });
  it('actually recovers content in a test database without reviving permissions, sessions, roles or approvals', async () => {
    const snapshot = await schoolSnapshot(db);
    const shareId = id(); await db.run("INSERT INTO share_links(id,board_id,target_type,target_id,scope,token_hash,code_hash,expires_at,created_at) VALUES($1,$2,'board',$2,'write',$3,$4,$5,$6)", [shareId, board, id(), id(), new Date(Date.now() + 86400000).toISOString(), now()]); await db.run("INSERT INTO board_members(board_id,principal_id,role) VALUES($1,$2,'editor')", [board, teacher]); await db.run('INSERT INTO participations(id,principal_id,board_id,share_id,share_version,created_at) VALUES($1,$2,$3,$4,1,$5)', [id(), student, board, shareId, now()]);
    await db.run('UPDATE principals SET disabled_at=$1 WHERE id=$2', [now(), student]); await db.run("UPDATE posts SET title='변경됨' WHERE id=$1", [post]);
    const newPost = id(); await db.run("INSERT INTO posts(id,board_id,author_id,title,status,created_at,updated_at) VALUES($1,$2,$3,'백업 이후 새 글','published',$4,$4)", [newPost, board, teacher, now()]);
    await mergeSchoolSnapshot(db, snapshot, admin);
    expect((await db.one<{ title: string; status: string }>('SELECT title,status FROM posts WHERE id=$1', [post]))).toEqual({ title: '승인 전 질문', status: 'pending' }); expect(await db.one('SELECT id FROM posts WHERE id=$1', [newPost])).toBeTruthy(); expect((await db.one<{ owner_id: string; state: string }>('SELECT owner_id,state FROM boards WHERE id=$1', [board]))).toEqual({ owner_id: admin, state: 'closed' }); expect((await db.one<{ disabled_at: string }>('SELECT disabled_at FROM principals WHERE id=$1', [student]))?.disabled_at).toBeTruthy(); expect((await db.one<{ role: string }>('SELECT role FROM principals WHERE id=$1', [teacher]))?.role).toBe('teacher'); expect(await db.one('SELECT id FROM sessions')).toBeNull(); expect(await db.one('SELECT id FROM participations')).toBeNull(); expect(await db.one('SELECT board_id FROM board_members')).toBeNull(); expect((await db.one<{ revoked_at: string }>('SELECT revoked_at FROM share_links WHERE id=$1', [shareId]))?.revoked_at).toBeTruthy();
    await expect(mergeSchoolSnapshot(db, { ...snapshot, tables: { ...snapshot.tables, 'posts;DROP TABLE boards': [] } }, admin)).rejects.toThrow('테이블'); expect(await db.one('SELECT id FROM boards WHERE id=$1', [board])).toBeTruthy();
  });
  it('executes scheduled backup and cleanup using the same guarded workflow', async () => { await runMaintenance(); const runs = await db.all<OperationRun>('SELECT * FROM operation_runs ORDER BY created_at DESC LIMIT 2'); expect(runs.map(run => run.kind).sort()).toEqual(['backup', 'cleanup']); expect(runs.every(run => run.status === 'completed')).toBe(true); });
  it('rolls back all content changes when an invalid backup column is found', async () => { const snapshot = await schoolSnapshot(db), bad = structuredClone(snapshot); bad.tables.posts[0]['title;DROP TABLE principals'] = 'bad'; bad.tables.boards[0].title = '저장되면 안됨'; await expect(mergeSchoolSnapshot(db, bad, admin)).rejects.toThrow('열 구성'); expect((await db.one<{ title: string }>('SELECT title FROM boards WHERE id=$1', [board]))?.title).toBe('복구할 게시판'); });
  it('uses randomized authenticated encryption', () => { const value = Buffer.from(JSON.stringify({ question: '합성 원문' })); expect(encryptBytes(value).equals(encryptBytes(value))).toBe(false); });
});
