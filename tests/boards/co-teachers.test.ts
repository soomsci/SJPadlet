import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import type { BoardActivity, BoardMembers, BoardView, Principal } from '@contracts';
import { getDb, id, now, type Database } from '@db';
import { createAnonymousSession } from '@server/auth';
import { handleBoards } from '@server/boards';
import { acceptMemberInvites } from '@server/boards/members';
import { boardAccess } from '@server/policy';

let db: Database, boardId: string;
const people: Record<'owner' | 'coteacher' | 'other', { principal: Principal; cookie: string }> = {} as never;
async function teacher(name: string) {
  const principal: Principal = { id: id(), role: 'teacher', display_name: name, email: `${id()}@samjeong.ms.kr`, disabled_at: null, provider_subject: id(), created_at: now() };
  await db.run('INSERT INTO principals(id,role,display_name,email,provider_subject,created_at) VALUES($1,$2,$3,$4,$5,$6)', [principal.id, principal.role, principal.display_name, principal.email, principal.provider_subject, principal.created_at]);
  const token = randomBytes(32).toString('base64url');
  await db.run('INSERT INTO sessions(id,principal_id,token_hash,expires_at,created_at) VALUES($1,$2,$3,$4,$5)', [id(), principal.id, createHash('sha256').update(token).digest('hex'), new Date(Date.now() + 3600000).toISOString(), now()]);
  return { principal, cookie: `samjeong_session=${token}` };
}
async function call<T>(path: string, cookie: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await handleBoards(new Request(`http://localhost:3000/api/${path}`, { method, headers: { cookie, 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }), path.split('?')[0].split('/'));
  expect(response).not.toBeNull(); return (await response!.json()).data as T;
}
const members = (cookie = people.owner.cookie, method = 'GET', body?: unknown) => call<BoardMembers>(`boards/${boardId}/members`, cookie, method, body);
const access = (who: keyof typeof people) => boardAccess(db, people[who].principal, boardId);

beforeAll(async () => { db = await getDb(); });
beforeEach(async () => {
  people.owner = await teacher('소유 교사'); people.coteacher = await teacher('공동 교사'); people.other = await teacher('다른 교사');
  boardId = (await call<BoardView>('boards', people.owner.cookie, 'POST', { title: '합성 공동 수업', format: 'columns' })).board.id;
});

describe('co-teacher membership', () => {
  it('lets the owner add an editor who can manage but not manage members', async () => {
    const list = await members(people.owner.cookie, 'POST', { email: people.coteacher.principal.email!.toUpperCase(), role: 'editor' });
    expect(list.members).toEqual([expect.objectContaining({ principal_id: people.coteacher.principal.id, role: 'editor', display_name: '공동 교사' })]);
    expect((await access('coteacher')).can_manage).toBe(true);
    const seen = await members(people.coteacher.cookie);
    expect(seen.can_edit_members).toBe(false); expect(seen.owner.id).toBe(people.owner.principal.id);
    await expect(members(people.coteacher.cookie, 'POST', { email: people.other.principal.email, role: 'editor' })).rejects.toMatchObject({ status: 403 });
    await expect(members(people.other.cookie)).rejects.toBeTruthy();
  });

  it('downgrades to read-only, removes, and lets a member leave', async () => {
    await members(people.owner.cookie, 'POST', { email: people.coteacher.principal.email, role: 'reader' });
    expect(await access('coteacher')).toMatchObject({ can_manage: false, can_write: false });
    await expect(members(people.coteacher.cookie)).rejects.toMatchObject({ status: 403 });
    await members(people.owner.cookie, 'DELETE', { principal_id: people.coteacher.principal.id });
    await expect(access('coteacher')).rejects.toBeTruthy();
    await members(people.owner.cookie, 'POST', { email: people.other.principal.email, role: 'editor' });
    expect(await members(people.other.cookie, 'DELETE', { principal_id: people.other.principal.id })).toEqual({ left: true });
    await expect(access('other')).rejects.toBeTruthy();
    await expect(members(people.other.cookie, 'DELETE', { principal_id: people.owner.principal.id })).rejects.toBeTruthy();
  });

  it('keeps invites for teachers who have not signed in and activates them only for a teacher role', async () => {
    const email = `new-${id()}@samjeong.ms.kr`;
    const list = await members(people.owner.cookie, 'POST', { email, role: 'editor' });
    expect(list.invites).toEqual([expect.objectContaining({ email, role: 'editor' })]);
    for (const bad of ['someone@example.com', 'x@samjeong.ms.kr.example.com']) await expect(members(people.owner.cookie, 'POST', { email: bad, role: 'editor' })).rejects.toMatchObject({ status: 400 });
    await expect(members(people.owner.cookie, 'POST', { email: people.owner.principal.email, role: 'editor' })).rejects.toMatchObject({ status: 400 });
    const student = id(); await db.run("INSERT INTO principals(id,role,display_name,email,created_at) VALUES($1,'student','학생',$2,$3)", [student, email, now()]);
    await db.transaction(tx => acceptMemberInvites(tx, student, email, 'student'));
    expect(await db.one('SELECT 1 FROM board_members WHERE principal_id=$1', [student])).toBeNull();
    await db.run("UPDATE principals SET role='teacher' WHERE id=$1", [student]);
    await db.transaction(tx => acceptMemberInvites(tx, student, email.toUpperCase(), 'teacher'));
    expect(await db.one('SELECT role FROM board_members WHERE board_id=$1 AND principal_id=$2', [boardId, student])).toEqual({ role: 'editor' });
    expect((await members()).invites).toEqual([]);
  });
});

describe('teacher activity and shared dashboard', () => {
  it('records who did which teacher action on this board and hides it from students', async () => {
    await members(people.owner.cookie, 'POST', { email: people.coteacher.principal.email, role: 'editor' });
    const view = await call<BoardView>(`boards/${boardId}/sections`, people.coteacher.cookie, 'POST', { title: '공동 섹션' });
    const activity = await call<BoardActivity[]>(`boards/${boardId}/activity`, people.owner.cookie);
    expect(activity[0]).toMatchObject({ action: 'section.create', actor_name: '공동 교사', target_id: view.sections.at(-1)!.id });
    expect(activity.map(item => item.action)).toContain('member.editor');
    const student = await createAnonymousSession('합성 학생');
    await expect(call(`boards/${boardId}/activity`, student.cookie)).rejects.toBeTruthy();
    const otherBoard = (await call<BoardView>('boards', people.other.cookie, 'POST', { title: '다른 수업' })).board.id;
    expect(await call<BoardActivity[]>(`boards/${otherBoard}/activity`, people.other.cookie)).toEqual([]);
  });

  it('marks shared boards with role and owner, filters them, and keeps others out of the trash', async () => {
    await members(people.owner.cookie, 'POST', { email: people.coteacher.principal.email, role: 'reader' });
    type Row = { id: string; my_role: string; owner_name: string };
    const own = (await call<{ boards: Row[] }>('boards', people.coteacher.cookie)).boards.find(board => board.id === boardId);
    expect(own).toMatchObject({ my_role: 'reader', owner_name: '소유 교사' });
    const mine = await call<BoardView>('boards', people.coteacher.cookie, 'POST', { title: '내 수업' });
    const shared = (await call<{ boards: Row[] }>('boards?shared=true', people.coteacher.cookie)).boards.map(board => board.id);
    expect(shared).toContain(boardId); expect(shared).not.toContain(mine.board.id);
    await call(`boards/${boardId}`, people.owner.cookie, 'DELETE', { version: (await call<BoardView>(`boards/${boardId}`, people.owner.cookie)).board.version });
    expect((await call<{ boards: Row[] }>('boards?trash=true', people.coteacher.cookie)).boards.map(board => board.id)).not.toContain(boardId);
    expect((await call<{ boards: Row[] }>('boards?trash=true', people.owner.cookie)).boards.map(board => board.id)).toContain(boardId);
  });
});
