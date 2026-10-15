import { beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import type { BoardView } from '@contracts';
import { getDb, id, now, type Database } from '@db';
import { createAnonymousSession } from '@server/auth';
import { dispatch } from '@server/dispatch';
import { performCleanup } from '@server/operations';

let db: Database, teacherCookie = '', teacherId = '';
async function call<T = BoardView>(path: string, method = 'GET', body?: unknown, cookie = teacherCookie) {
  const response = await dispatch(new Request('http://localhost:3000/api/' + path, { method, headers: { cookie, origin: 'http://localhost:3000', 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }), path.split('?')[0].split('/'));
  return { status: response.status, data: (await response.json()).data as T };
}
async function openBoard(extra: Record<string, unknown> = {}) {
  const created = (await call('boards', 'POST', { title: '합성 개선 수업', format: 'columns', ...extra })).data;
  const opened = (await call(`boards/${created.board.id}`, 'PATCH', { version: created.board.version, state: 'open' })).data;
  const share = (await call<{ url: string }>('shares', 'POST', { board_id: opened.board.id, target_type: 'board', target_id: opened.board.id, scope: 'write', expires_hours: 2 })).data;
  const join = async () => { const cookie = (await createAnonymousSession('합성 학생')).cookie.split(';')[0]; await call('join', 'POST', { token: share.url.split('/s/')[1], mode: 'anonymous', continue: true }, cookie); return cookie; };
  return { board: opened, join };
}
beforeAll(async () => {
  db = await getDb(); teacherId = id(); const token = randomBytes(32).toString('base64url');
  await db.run("INSERT INTO principals(id,role,display_name,email,provider_subject,created_at) VALUES($1,'teacher','합성 교사',$2,$3,$4)", [teacherId, `${teacherId}@samjeong.ms.kr`, teacherId, now()]);
  await db.run('INSERT INTO sessions(id,principal_id,token_hash,expires_at,created_at) VALUES($1,$2,$3,$4,$5)', [id(), teacherId, createHash('sha256').update(token).digest('hex'), new Date(Date.now() + 3600000).toISOString(), now()]);
  teacherCookie = `samjeong_session=${token}`;
});

describe('classroom improvements', () => {
  it('lets authors delete their own comment while open and teachers delete any, with a teacher log entry', async () => {
    const { board, join } = await openBoard(); const a = await join(), b = await join();
    const posted = (await call<{ post_id: string; view: BoardView }>(`boards/${board.board.id}/posts`, 'POST', { title: '합성 글', section_id: board.sections[0].id }, a)).data;
    const comment = async (cookie: string, text: string) => (await call(`posts/${posted.post_id}/comments`, 'POST', { body: text }, cookie)).data.posts[0].comments.find(item => item.body === text)!.id;
    const mine = await comment(a, '내 합성 댓글'), theirs = await comment(b, '다른 합성 댓글'), third = await comment(b, '세 번째 합성 댓글');
    expect((await call(`posts/${posted.post_id}/comments/${theirs}`, 'DELETE', {}, a)).status).toBe(403);
    expect((await call(`posts/${posted.post_id}/comments/${mine}`, 'DELETE', {}, a)).status).toBe(200);
    expect((await call(`posts/${posted.post_id}/comments/${theirs}`, 'DELETE', {}, teacherCookie)).status).toBe(200);
    const left = (await call(`boards/${board.board.id}`)).data.posts[0].comments.map(item => item.id);
    expect(left).toEqual([third]);
    expect(await db.one("SELECT 1 FROM audit_events WHERE action='comment.delete' AND target_id=$1 AND board_id=$2", [theirs, board.board.id])).toBeTruthy();
    const latest = (await call(`boards/${board.board.id}`)).data.board;
    await call(`boards/${board.board.id}`, 'PATCH', { version: latest.version, state: 'closed' });
    expect((await call(`posts/${posted.post_id}/comments/${third}`, 'DELETE', {}, b)).status).toBe(403);
  });
  it('accepts posts without a title but rejects completely empty ones', async () => {
    const { board, join } = await openBoard(); const student = await join();
    const created = await call<{ post_id: string; view: BoardView }>(`boards/${board.board.id}/posts`, 'POST', { body: '제목 없는 합성 생각', section_id: board.sections[0].id }, student);
    expect(created.status).toBe(201);
    const post = created.data.view.posts.find(item => item.id === created.data.post_id)!;
    expect(post.title).toBe('');
    expect((await call(`boards/${board.board.id}/posts`, 'POST', { title: '   ', body: '' }, student)).status).toBe(400);
    expect((await call(`posts/${post.id}`, 'PATCH', { version: post.version, body: '' }, student)).status).toBe(400);
  });
  it('publishes waiting posts only when the teacher asks while turning approval off', async () => {
    for (const publish of [false, true]) {
      const { board, join } = await openBoard({ moderation: true }); const student = await join();
      await call(`boards/${board.board.id}/posts`, 'POST', { title: '대기 합성 글' }, student);
      const current = (await call(`boards/${board.board.id}`)).data;
      expect(current.posts[0].status).toBe('pending');
      const after = (await call(`boards/${board.board.id}`, 'PATCH', { version: current.board.version, moderation: false, publish_pending: publish })).data;
      expect(after.posts[0].status).toBe(publish ? 'published' : 'pending');
    }
  });
  it('purges boards 30 days after they enter the trash, once their files are gone', async () => {
    const old = await openBoard(), recent = await openBoard(), withFile = await openBoard();
    const student = await old.join();
    const posted = (await call<{ post_id: string }>(`boards/${old.board.board.id}/posts`, 'POST', { title: '지울 합성 글' }, student)).data;
    await call(`posts/${posted.post_id}/comments`, 'POST', { body: '지울 합성 댓글' }, student);
    await call(`posts/${posted.post_id}/reaction`, 'PUT', { liked: true }, student);
    await call(`boards/${old.board.board.id}/favorite`, 'PUT', { favorite: true });
    // A live draft pins this file, so attachment cleanup keeps it and the trashed board must wait for it.
    const file = id();
    await db.run("INSERT INTO attachments(id,board_id,uploader_id,name,mime,bytes,storage_key,status,created_at) VALUES($1,$2,$3,'합성.png','image/png',10,$4,'ready',$5)", [file, withFile.board.board.id, teacherId, id(), now()]);
    await db.run('INSERT INTO post_drafts(id,board_id,principal_id,attachment_ids,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$5)', [id(), withFile.board.board.id, teacherId, JSON.stringify([file]), now()]);
    const longAgo = new Date(Date.now() - 31 * 86400000).toISOString();
    for (const [target, at] of [[old, longAgo], [recent, new Date(Date.now() - 10 * 86400000).toISOString()], [withFile, longAgo]] as const) await db.run('UPDATE boards SET deleted_at=$2 WHERE id=$1', [target.board.board.id, at]);
    await performCleanup(db, 'test');
    expect(await db.one('SELECT 1 FROM boards WHERE id=$1', [old.board.board.id])).toBeNull();
    expect(await db.one('SELECT 1 FROM posts WHERE id=$1', [posted.post_id])).toBeNull();
    expect(await db.one('SELECT 1 FROM boards WHERE id=$1', [recent.board.board.id])).toBeTruthy();
    expect(await db.one('SELECT 1 FROM boards WHERE id=$1', [withFile.board.board.id])).toBeTruthy();
  });
});
