import { z } from 'zod';
import type { BoardActivity, BoardMembers, Principal } from '@contracts';
import { audit, emit, now, type Database } from '@db';
import { boardAccess } from '@server/policy';
import { fail, input, json } from '@server/common/http';

const role = z.enum(['editor', 'reader']);
const schoolEmail = z.string().trim().toLowerCase().pipe(z.email()).refine(email => email.split('@').length === 2 && email.split('@')[1] === 'samjeong.ms.kr', '학교 선생님 이메일(@samjeong.ms.kr)을 입력해주세요.');

async function members(db: Database, boardId: string, canEdit: boolean): Promise<BoardMembers> {
  const owner = (await db.one<BoardMembers['owner']>('SELECT p.id,p.display_name,p.email FROM boards b JOIN principals p ON p.id=b.owner_id WHERE b.id=$1', [boardId]))!;
  return {
    owner,
    members: await db.all<BoardMembers['members'][number]>('SELECT m.principal_id,p.display_name,p.email,m.role FROM board_members m JOIN principals p ON p.id=m.principal_id WHERE m.board_id=$1 ORDER BY p.display_name', [boardId]),
    invites: await db.all<BoardMembers['invites'][number]>('SELECT email,role,created_at FROM board_member_invites WHERE board_id=$1 ORDER BY email', [boardId]),
    can_edit_members: canEdit,
  };
}
/** Locks the board, then requires an active owner (or, for self-removal, any member). */
async function locked(tx: Database, actor: Principal, boardId: string) {
  await tx.one('SELECT id FROM boards WHERE id=$1 FOR UPDATE', [boardId]);
  const access = await boardAccess(tx, actor, boardId);
  return { access, isOwner: access.can_manage && access.board.owner_id === actor.id };
}

/** Co-teacher membership (owner manages, editors view) and the managers-only teacher activity feed. */
export async function handleMembers(req: Request, path: string[], actor: Principal, db: Database): Promise<Response | null> {
  const [, boardId, child] = path;
  if (path.length !== 3) return null;
  if (child === 'activity' && req.method === 'GET') {
    const access = await boardAccess(db, actor, boardId);
    if (!access.can_manage) fail(403, 'FORBIDDEN', '교사 편집 권한이 필요합니다.');
    return json(await db.all<BoardActivity>('SELECT a.id,a.action,a.target_id,p.display_name AS actor_name,a.created_at FROM audit_events a JOIN principals p ON p.id=a.actor_id WHERE a.board_id=$1 ORDER BY a.created_at DESC,a.id LIMIT 50', [boardId]));
  }
  if (child !== 'members') return null;
  if (req.method === 'GET') {
    const access = await boardAccess(db, actor, boardId);
    if (!access.can_manage) fail(403, 'FORBIDDEN', '교사 편집 권한이 필요합니다.');
    return json(await members(db, boardId, access.board.owner_id === actor.id));
  }
  if (req.method === 'POST') {
    const data = await input(req, z.object({ email: schoolEmail, role }));
    await db.transaction(async tx => {
      const { access, isOwner } = await locked(tx, actor, boardId);
      if (!isOwner) fail(403, 'FORBIDDEN', '소유 교사만 함께하는 선생님을 관리할 수 있습니다.');
      const teacher = await tx.one<Principal>("SELECT * FROM principals WHERE lower(email)=$1 AND role IN ('teacher','admin') AND disabled_at IS NULL", [data.email]);
      if (teacher?.id === access.board.owner_id) fail(400, 'INVALID_INPUT', '이미 소유 교사입니다.');
      // Teachers who have not signed in yet get a pending invite; it activates only if they sign in with a teacher role.
      if (teacher) {
        await tx.run('INSERT INTO board_members(board_id,principal_id,role) VALUES($1,$2,$3) ON CONFLICT(board_id,principal_id) DO UPDATE SET role=EXCLUDED.role', [boardId, teacher.id, data.role]);
        await tx.run('DELETE FROM board_member_invites WHERE board_id=$1 AND email=$2', [boardId, data.email]);
      } else await tx.run('INSERT INTO board_member_invites(board_id,email,role,invited_by,created_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(board_id,email) DO UPDATE SET role=EXCLUDED.role', [boardId, data.email, data.role, actor.id, now()]);
      await emit(tx, boardId, 'permissions'); await audit(tx, actor.id, `member.${data.role}`, data.email, boardId);
    });
    return json(await members(db, boardId, true));
  }
  if (req.method === 'DELETE') {
    const data = await input(req, z.union([z.object({ principal_id: z.string().min(1) }), z.object({ email: schoolEmail })]));
    const leaving = 'principal_id' in data && data.principal_id === actor.id;
    await db.transaction(async tx => {
      const { isOwner } = await locked(tx, actor, boardId);
      if (!isOwner && !leaving) fail(403, 'FORBIDDEN', '소유 교사만 함께하는 선생님을 관리할 수 있습니다.');
      if ('principal_id' in data) {
        const removed = await tx.one('DELETE FROM board_members WHERE board_id=$1 AND principal_id=$2 RETURNING principal_id', [boardId, data.principal_id]);
        if (!removed) fail(404, 'NOT_FOUND', '함께하는 선생님을 찾을 수 없습니다.');
      } else await tx.run('DELETE FROM board_member_invites WHERE board_id=$1 AND email=$2', [boardId, data.email]);
      await emit(tx, boardId, 'permissions'); await audit(tx, actor.id, leaving ? 'member.leave' : 'member.remove', 'principal_id' in data ? data.principal_id : data.email, boardId);
    });
    return leaving ? json({ left: true }) : json(await members(db, boardId, true));
  }
  return null;
}

/** Turns pending invites for a teacher's email into memberships at sign-in. */
export async function acceptMemberInvites(tx: Database, principalId: string, email: string, principalRole: Principal['role']) {
  if (!['teacher', 'admin'].includes(principalRole)) return;
  await tx.run('INSERT INTO board_members(board_id,principal_id,role) SELECT i.board_id,$1,i.role FROM board_member_invites i JOIN boards b ON b.id=i.board_id WHERE i.email=$2 AND b.owner_id<>$1 ON CONFLICT(board_id,principal_id) DO NOTHING', [principalId, email.toLowerCase()]);
  await tx.run('DELETE FROM board_member_invites WHERE email=$1', [email.toLowerCase()]);
}
