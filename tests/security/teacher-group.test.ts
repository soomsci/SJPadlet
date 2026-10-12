import { beforeAll, beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { decodeJwt, exportPKCS8, generateKeyPair } from 'jose';
import { getDb, now, type Database } from '@db';
import { googleAdmissionRole, recheckTeacherGroup, teacherGroupMembership } from '@server/auth';

let db: Database, privateKey: string;
const group = 'teachers@samjeong.ms.kr';
const claims = (email: string) => ({ sub: `sub-${email}`, email, email_verified: true, hd: 'samjeong.ms.kr' });
let members = new Set<string>(), failLookup = false;
const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  if (failLookup) return new Response('{}', { status: 500 });
  if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'directory-token' });
  const match = url.match(/groups\/([^/]+)\/hasMember\/([^/]+)$/);
  if (match && new Headers(init?.headers).get('Authorization') === 'Bearer directory-token') return Response.json({ isMember: decodeURIComponent(match[1]) === group && members.has(decodeURIComponent(match[2])) });
  return new Response('{}', { status: 404 });
});
async function seedTeacher(principalId: string, email: string) {
  await db.run("INSERT INTO principals(id,role,display_name,email,provider_subject,created_at) VALUES($1,'teacher',$2,$3,$4,$5)", [principalId, principalId, email, `sub-${principalId}`, now()]);
  await db.run('INSERT INTO sessions(id,principal_id,token_hash,expires_at,created_at) VALUES($1,$2,$3,$4,$5)', [`session-${principalId}`, principalId, `hash-${principalId}`, new Date(Date.now() + 86400000).toISOString(), now()]);
}
const role = async (principalId: string) => (await db.one<{ role: string }>('SELECT role FROM principals WHERE id=$1', [principalId]))?.role;
const sessions = async (principalId: string) => (await db.all('SELECT id FROM sessions WHERE principal_id=$1', [principalId])).length;

beforeAll(async () => {
  db = await getDb();
  const pair = await generateKeyPair('RS256', { extractable: true });
  privateKey = await exportPKCS8(pair.privateKey);
});
beforeEach(async () => {
  members = new Set(['group.teacher@samjeong.ms.kr']); failLookup = false; fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('TEACHER_ADMISSION', 'allowlist'); vi.stubEnv('TEACHER_EMAILS', 'listed@samjeong.ms.kr'); vi.stubEnv('ADMIN_EMAILS', 'admin@samjeong.ms.kr');
  vi.stubEnv('TEACHER_GROUP_EMAIL', group); vi.stubEnv('GOOGLE_DIRECTORY_SUBJECT', 'admin@samjeong.ms.kr');
  vi.stubEnv('GOOGLE_DIRECTORY_KEY', JSON.stringify({ client_email: 'directory@school.iam.gserviceaccount.com', private_key: privateKey }));
  await db.run('TRUNCATE principals, teacher_admissions CASCADE');
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('teacher Google group admission', () => {
  it('admits a group member and signs a narrowly scoped, delegated directory assertion', async () => {
    const payload = claims('group.teacher@samjeong.ms.kr'), member = await teacherGroupMembership(payload);
    expect(member).toBe(true);
    expect(await googleAdmissionRole(db, payload, 'teacher', member)).toBe('teacher');
    const assertion = decodeJwt(new URLSearchParams(String(fetchMock.mock.calls[0][1]!.body)).get('assertion')!);
    expect(assertion).toMatchObject({ iss: 'directory@school.iam.gserviceaccount.com', sub: 'admin@samjeong.ms.kr', scope: 'https://www.googleapis.com/auth/admin.directory.group.member.readonly', aud: 'https://oauth2.googleapis.com/token' });
  });

  it('keeps a same-domain student out of the teacher role', async () => {
    const payload = claims('student@samjeong.ms.kr'), member = await teacherGroupMembership(payload);
    expect(member).toBe(false);
    expect(await googleAdmissionRole(db, payload, 'student', member)).toBe('student');
    await expect(googleAdmissionRole(db, payload, 'teacher', member)).rejects.toMatchObject({ status: 403, code: 'TEACHER_NOT_ADMITTED' });
  });

  it('lets an explicit administrator denial override group membership', async () => {
    await db.run('INSERT INTO teacher_admissions(email,enabled,created_by,created_at) VALUES($1,false,$2,$3)', ['group.teacher@samjeong.ms.kr', 'admin', now()]);
    const payload = claims('group.teacher@samjeong.ms.kr');
    expect(await googleAdmissionRole(db, payload, 'student', await teacherGroupMembership(payload))).toBe('student');
  });

  it('fails a teacher login closed when the lookup fails but still lets students sign in', async () => {
    failLookup = true;
    const payload = claims('group.teacher@samjeong.ms.kr'), member = await teacherGroupMembership(payload);
    expect(member).toBeNull();
    await expect(googleAdmissionRole(db, payload, 'teacher', member)).rejects.toMatchObject({ status: 503, code: 'TEACHER_GROUP_UNAVAILABLE' });
    expect(await googleAdmissionRole(db, payload, 'student', member)).toBe('student');
  });

  it('does not call Google for non-school claims, env-listed teachers, or when no group is configured', async () => {
    for (const payload of [{ ...claims('group.teacher@samjeong.ms.kr'), hd: undefined }, { ...claims('group.teacher@samjeong.ms.kr'), email_verified: false }, claims('listed@samjeong.ms.kr'), claims('admin@samjeong.ms.kr')]) expect(await teacherGroupMembership(payload)).toBeUndefined();
    vi.stubEnv('TEACHER_GROUP_EMAIL', '');
    expect(await teacherGroupMembership(claims('group.teacher@samjeong.ms.kr'))).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('daily recheck demotes only group-admitted teachers who left the group and ends their sessions', async () => {
    await seedTeacher('left', 'left@samjeong.ms.kr');
    await seedTeacher('stayed', 'group.teacher@samjeong.ms.kr');
    await seedTeacher('listed', 'listed@samjeong.ms.kr');
    await seedTeacher('admitted', 'admitted@samjeong.ms.kr');
    await db.run('INSERT INTO teacher_admissions(email,enabled,created_by,created_at) VALUES($1,true,$2,$3)', ['admitted@samjeong.ms.kr', 'admin', now()]);
    expect(await recheckTeacherGroup(db)).toBe(1);
    expect([await role('left'), await sessions('left')]).toEqual(['student', 0]);
    for (const kept of ['stayed', 'listed', 'admitted']) expect([await role(kept), await sessions(kept)]).toEqual(['teacher', 1]);
    expect(await db.one('SELECT 1 FROM audit_events WHERE action=$1 AND target_id=$2', ['teacher.group_revoke', 'left'])).toBeTruthy();
  });

  it('daily recheck demotes nobody when Google cannot be reached', async () => {
    await seedTeacher('left', 'left@samjeong.ms.kr');
    failLookup = true;
    await expect(recheckTeacherGroup(db)).rejects.toThrow();
    expect([await role('left'), await sessions('left')]).toEqual(['teacher', 1]);
  });
});
