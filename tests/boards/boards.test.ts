import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { getDb, id, now, type Database } from '@db';
import { createAnonymousSession } from '@server/auth';
import { getBoardView, handleBoards } from '@server/boards';
import type { BoardView, Principal, Share } from '@contracts';

let db: Database, teacher: Principal, student: Principal, other: Principal;
let teacherCookie: string, studentCookie: string, otherCookie: string, boardId: string, sectionId: string;
async function invoke<T = BoardView>(path: string, value?: unknown, cookie = teacherCookie, method = value === undefined ? 'GET' : 'POST', idem?: string): Promise<T> {
  const response = await handleBoards(new Request(`http://localhost:3000/api/${path}`, { method, headers: { cookie, 'Content-Type': 'application/json', ...(idem ? { 'Idempotency-Key': idem } : {}) }, ...(value !== undefined ? { body: JSON.stringify(value) } : {}) }), path.split('/'));
  expect(response).not.toBeNull();
  return (await response!.json()).data as T;
}
async function grant(p: Principal, type: Share['target_type'] = 'board', scope: Share['scope'] = 'write', target = boardId) {
  const shareId = id();
  await db.run('INSERT INTO share_links(id,board_id,target_type,target_id,scope,token_hash,code_hash,expires_at,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)', [shareId, boardId, type, target, scope, id(), id(), new Date(Date.now() + 3600000).toISOString(), now()]);
  await db.run('INSERT INTO participations(id,principal_id,board_id,share_id,share_version,created_at) VALUES($1,$2,$3,$4,1,$5)', [id(), p.id, boardId, shareId, now()]);
}
async function post(cookie = studentCookie, title = '합성 수업 질문', extra = {}) {
  return invoke<{ post_id: string; view: BoardView }>(`boards/${boardId}/posts`, { title, body: '합성 답변', section_id: sectionId, ...extra }, cookie);
}
async function readyFile(uploader = student.id, board = boardId) {
  const file = id(); await db.run("INSERT INTO attachments(id,board_id,uploader_id,name,mime,bytes,storage_key,status,created_at) VALUES($1,$2,$3,'test.txt','text/plain',4,$4,'ready',$5)", [file, board, uploader, id(), now()]); return file;
}
beforeAll(async () => { db = await getDb(); });
beforeEach(async () => {
  teacher = { id: id(), role: 'teacher', display_name: '합성 교사', email: `${id()}@samjeong.ms.kr`, disabled_at: null, provider_subject: id(), created_at: now() };
  await db.run('INSERT INTO principals(id,role,display_name,email,provider_subject,created_at) VALUES($1,$2,$3,$4,$5,$6)', [teacher.id, teacher.role, teacher.display_name, teacher.email, teacher.provider_subject, teacher.created_at]);
  const token = randomBytes(32).toString('base64url'); teacherCookie = `samjeong_session=${token}`;
  await db.run('INSERT INTO sessions(id,principal_id,token_hash,expires_at,created_at) VALUES($1,$2,$3,$4,$5)', [id(), teacher.id, createHash('sha256').update(token).digest('hex'), new Date(Date.now() + 3600000).toISOString(), now()]);
  const a = await createAnonymousSession('합성 A'), b = await createAnonymousSession('합성 B'); student = a.principal; studentCookie = a.cookie; other = b.principal; otherCookie = b.cookie;
  const created = await invoke('boards', { title: '합성 과학 수업', format: 'columns', moderation: true, participation_mode: 'both', description: '실제 학생 자료 없음', color: '#e2eafa' });
  boardId = created.board.id; sectionId = created.sections[0].id;
  await invoke(`boards/${boardId}`, { state: 'open', version: created.board.version }, teacherCookie, 'PATCH');
  await grant(student); await grant(other);
});

describe('persisted board lifecycle and settings', () => {
  it('opening changes only supplied properties and preserves moderation, format, text and colour', async () => {
    const result = await getBoardView(teacher, boardId);
    expect(result.board).toMatchObject({ state: 'open', moderation: true, format: 'columns', title: '합성 과학 수업', description: '실제 학생 자료 없음', color: '#e2eafa' });
    expect((await post()).view.posts[0].status).toBe('pending');
  });
  it('preserves posts on layout change and enforces optimistic versions', async () => {
    await post(); const current = await getBoardView(teacher, boardId);
    const next = await invoke(`boards/${boardId}`, { version: current.board.version, format: 'grid' }, teacherCookie, 'PATCH');
    expect(next.board.format).toBe('grid'); expect(next.posts).toHaveLength(1);
    await expect(invoke(`boards/${boardId}`, { version: current.board.version, title: 'stale' }, teacherCookie, 'PATCH')).rejects.toMatchObject({ status: 409 });
  });
  it('supports favorites, search, trash and owner restore as closed', async () => {
    await invoke(`boards/${boardId}/favorite`, { favorite: true }, teacherCookie, 'PUT');
    const list = await invoke<{ boards: Array<{ id: string; favorite: boolean }> }>('boards'); expect(list.boards.find(item => item.id === boardId)?.favorite).toBe(true);
    const current = await getBoardView(teacher, boardId);
    await invoke(`boards/${boardId}`, { version: current.board.version }, teacherCookie, 'DELETE');
    await expect(getBoardView(student, boardId)).rejects.toMatchObject({ status: 404 });
    const deleted = await db.one<{ version: number }>('SELECT version FROM boards WHERE id=$1', [boardId]);
    const restored = await invoke(`boards/${boardId}/restore`, { version: deleted!.version }); expect(restored.board.state).toBe('closed');
  });
  it('duplicates settings and sections privately without copying student ownership or shares', async () => {
    const own = await post(teacherCookie, '공개 자료');
    const duplicate = await invoke(`boards/${boardId}/duplicate`, { include_posts: true });
    expect(duplicate.board.state).toBe('draft'); expect(duplicate.board.moderation).toBe(true); expect(duplicate.posts).toHaveLength(1); expect(duplicate.posts[0].id).not.toBe(own.post_id); expect(duplicate.posts[0].is_mine).toBe(true);
    await expect(getBoardView(student, duplicate.board.id)).rejects.toMatchObject({ status: 404 });
  });
  it('section ordering is teacher only and uses the current board version', async () => {
    let view = await invoke(`boards/${boardId}/sections`, { title: '두 번째', rank: 100 });
    const second = view.sections[1].id;
    await expect(invoke(`boards/${boardId}/sections/${second}/order`, { version: view.board.version, direction: 'up' }, studentCookie)).rejects.toMatchObject({ status: 403 });
    const previous = view.board.version;
    view = await invoke(`boards/${boardId}/sections/${second}/order`, { version: previous, direction: 'up' });
    expect(view.sections.map(item => item.id)).toEqual([second, sectionId]);
    await expect(invoke(`boards/${boardId}/sections/${second}/order`, { version: previous, direction: 'down' })).rejects.toMatchObject({ status: 409 });
  });
});
describe('author ownership, moderation, files and retry safety', () => {
  it('never exposes pending content or internal author IDs to other students', async () => {
    const attached = await readyFile(); await post(studentCookie, '나의 대기 글', { attachment_ids: [attached] }); await post(otherCookie, '타인의 대기 글');
    const studentView = await getBoardView(student, boardId); expect(studentView.posts).toHaveLength(1); expect(studentView.posts[0].attachments).toHaveLength(1); expect(studentView.posts[0]).not.toHaveProperty('author_id'); expect(studentView.posts[0].attachments[0]).not.toHaveProperty('storage_key'); expect(studentView.posts[0].attachments[0]).not.toHaveProperty('uploader_id');
    expect((await getBoardView(teacher, boardId)).posts).toHaveLength(2);
  });
  it('anonymous owner edits re-enter pending and stale updates fail', async () => {
    const created = await post(); await invoke(`posts/${created.post_id}/moderation`, { version: 1, status: 'published' });
    expect((await getBoardView(other, boardId)).posts).toHaveLength(1);
    await expect(invoke(`posts/${created.post_id}`, { title: '탈취', version: 2, section_id: sectionId }, otherCookie, 'PATCH')).rejects.toMatchObject({ status: 403 });
    await invoke(`posts/${created.post_id}`, { title: '수정', version: 2, section_id: sectionId }, studentCookie, 'PATCH');
    expect((await getBoardView(other, boardId)).posts).toHaveLength(0);
    await expect(invoke(`posts/${created.post_id}`, { title: '이전 버전', version: 2, section_id: sectionId }, studentCookie, 'PATCH')).rejects.toMatchObject({ status: 409 });
  });
  it('deduplicates posts and rejects reuse with a different payload', async () => {
    const payload = { title: '재시도', section_id: sectionId };
    const a = await invoke<{ post_id: string }>(`boards/${boardId}/posts`, payload, studentCookie, 'POST', 'retry-key-1234');
    const b = await invoke<{ post_id: string }>(`boards/${boardId}/posts`, payload, studentCookie, 'POST', 'retry-key-1234'); expect(a.post_id).toBe(b.post_id);
    expect((await getBoardView(student, boardId)).posts).toHaveLength(1);
    await expect(invoke(`boards/${boardId}/posts`, { ...payload, title: '다른 글' }, studentCookie, 'POST', 'retry-key-1234')).rejects.toMatchObject({ status: 409 });
  });
  it('partial post edits preserve omitted content, section, link and attachments', async () => {
    const file = await readyFile();
    const created = await post(studentCookie, '원래 제목', { link: 'https://example.invalid/classroom', attachment_ids: [file] });
    const edited = await invoke(`posts/${created.post_id}`, { title: '새 제목', version: 1 }, studentCookie, 'PATCH');
    expect(edited.posts[0]).toMatchObject({ title: '새 제목', body: '합성 답변', section_id: sectionId, link: 'https://example.invalid/classroom' });
    expect(edited.posts[0].attachments.map(item => item.id)).toEqual([file]);
  });
  it('keyboard move preserves content and rejects student ordering and stale versions', async () => {
    const a = await post(teacherCookie, '첫 글'), b = await post(teacherCookie, '둘째 글');
    await expect(invoke(`posts/${b.post_id}/order`, { version: 1, direction: 'up' }, studentCookie)).rejects.toMatchObject({ status: 403 });
    const ordered = await invoke(`posts/${b.post_id}/order`, { version: 1, direction: 'up' });
    expect(ordered.posts.map(item => item.id)).toEqual([b.post_id, a.post_id]);
    expect(ordered.posts[0].body).toBe('합성 답변');
    await expect(invoke(`posts/${b.post_id}/order`, { version: 1, direction: 'down' })).rejects.toMatchObject({ status: 409 });
  });
  it('rejects foreign uploads atomically without a post or outbox event', async () => {
    const file = await readyFile(other.id); const before = await db.one<{ total: string }>('SELECT COUNT(*) AS total FROM outbox_events WHERE board_id=$1', [boardId]);
    await expect(post(studentCookie, '훔친 파일', { attachment_ids: [file] })).rejects.toMatchObject({ code: 'UPLOAD_REJECTED' });
    expect((await getBoardView(student, boardId)).posts).toHaveLength(0); expect((await db.one<{ total: string }>('SELECT COUNT(*) AS total FROM outbox_events WHERE board_id=$1', [boardId]))?.total).toBe(before?.total);
  });
  it('comments retry once, reactions are idempotent, switches and closing enforce server policy', async () => {
    const created = await post(teacherCookie); const path = `posts/${created.post_id}`;
    await invoke(`${path}/comments`, { body: '합성 댓글' }, studentCookie, 'POST', 'comment-key-1234'); await invoke(`${path}/comments`, { body: '합성 댓글' }, studentCookie, 'POST', 'comment-key-1234');
    await invoke(`${path}/reaction`, { liked: true }, studentCookie, 'PUT'); await invoke(`${path}/reaction`, { liked: true }, studentCookie, 'PUT');
    let view = await getBoardView(teacher, boardId); expect(view.posts[0].comments).toHaveLength(1); expect(view.posts[0].likes).toBe(1); expect(view.posts[0].comments[0]).not.toHaveProperty('author_id');
    view = await invoke(`boards/${boardId}`, { version: view.board.version, allow_comments: false, allow_reactions: false }, teacherCookie, 'PATCH');
    await expect(invoke(`${path}/comments`, { body: '금지' }, studentCookie)).rejects.toMatchObject({ status: 403 }); await expect(invoke(`${path}/reaction`, { liked: false }, studentCookie, 'PUT')).rejects.toMatchObject({ status: 403 });
    await invoke(`boards/${boardId}`, { version: view.board.version, state: 'closed' }, teacherCookie, 'PATCH'); await expect(post()).rejects.toMatchObject({ code: 'BOARD_CLOSED' });
  });
});
describe('share scope cannot be broadened by read permission', () => {
  it('post-only writing cannot create posts or write on another visible post', async () => {
    const a = await post(teacherCookie, 'A'), b = await post(teacherCookie, 'B');
    await db.run('DELETE FROM participations WHERE principal_id=$1', [student.id]); await grant(student, 'board', 'read'); await grant(student, 'post', 'write', a.post_id);
    await expect(post()).rejects.toMatchObject({ status: 403 });
    await invoke(`posts/${a.post_id}/comments`, { body: '허용' }, studentCookie);
    await expect(invoke(`posts/${b.post_id}/comments`, { body: '우회' }, studentCookie)).rejects.toMatchObject({ status: 403 });
    await expect(invoke(`posts/${b.post_id}/reaction`, { liked: true }, studentCookie, 'PUT')).rejects.toMatchObject({ status: 403 });
  });
  it('section write grants constrain creation and edits, and submission only returns own records', async () => {
    const second = id(); await db.run('INSERT INTO sections(id,board_id,title) VALUES($1,$2,$3)', [second, boardId, '다른 섹션']);
    await db.run('DELETE FROM participations WHERE principal_id=$1', [student.id]); await grant(student, 'section', 'write', sectionId); await grant(student, 'board', 'read');
    await post(); await expect(post(studentCookie, '범위 밖', { section_id: second })).rejects.toMatchObject({ status: 403 });
    await db.run('DELETE FROM participations WHERE principal_id=$1', [student.id]); await grant(student, 'submission'); await post(otherCookie, '다른 답안'); await post(teacherCookie, '교사 공개 글');
    const view = await getBoardView(student, boardId); expect(view.submission_only).toBe(true); expect(view.posts).toHaveLength(1); expect(view.posts[0].is_mine).toBe(true);
  });
});
