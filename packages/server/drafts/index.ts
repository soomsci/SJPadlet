import { z } from 'zod';
import type { Attachment, Post, PostDraft, Principal } from '@contracts';
import { getDb, now, type Database } from '@db';
import { requirePrincipal } from '@server/auth';
import { fail, input, json } from '@server/common/http';
import { boardAccess, canReadPost, canWritePost, type BoardAccess } from '@server/policy';

export const draftRetentionDays = 14;
const versionSchema = z.object({ version: z.number().int().nonnegative() });
const draftSchema = versionSchema.extend({
  edit_post_id: z.string().nullable().default(null), edit_post_version: z.number().int().positive().nullable().default(null), section_id: z.string().nullable().default(null),
  title: z.string().max(200).default(''), body: z.string().max(10000).default(''),
  // Incomplete links are valid while composing; publishing validates an actual URL.
  link: z.string().max(2048).default(''), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#ffffff'),
  attachment_ids: z.array(z.string()).max(5).default([]),
});
const cutoff = () => new Date(Date.now() - draftRetentionDays * 86400000).toISOString();
function writable(access: BoardAccess) {
  if (!access.can_write) fail(403, access.board.state === 'closed' ? 'BOARD_CLOSED' : 'FORBIDDEN', '현재 이 활동에 초안을 작성할 수 없습니다.');
}
async function lockAccess(tx: Database, principal: Principal, boardId: string, writing = true) {
  await tx.one('SELECT id FROM boards WHERE id=$1 FOR UPDATE', [boardId]);
  const access = await boardAccess(tx, principal, boardId); if (writing) writable(access); return access;
}
async function allowed(tx: Database, p: Principal, access: BoardAccess, data: Pick<PostDraft, 'edit_post_id' | 'section_id'>, writing = true): Promise<boolean> {
  if (!writing) return access.can_manage || !access.shares.length || access.shares.some(s => s.target_type !== 'post' || s.target_id === data.edit_post_id);
  if (data.section_id && !await tx.one('SELECT id FROM sections WHERE id=$1 AND board_id=$2 AND deleted_at IS NULL', [data.section_id, access.board.id])) return false;
  if (data.edit_post_id) {
    const post = await tx.one<Post>('SELECT * FROM posts WHERE id=$1', [data.edit_post_id]);
    if (!post || !canReadPost(access, p, post) || (writing && !canWritePost(access, p, post)) || (!access.can_manage && post.author_id !== p.id)) return false;
  }
  if (access.can_manage) return true;
  return access.shares.some(s => s.scope === 'write' && (s.target_type === 'board' || s.target_type === 'submission' || (s.target_type === 'section' && s.target_id === data.section_id) || (data.edit_post_id && s.target_type === 'post' && s.target_id === data.edit_post_id)));
}
async function attachments(tx: Database, p: Principal, boardId: string, data: Pick<PostDraft, 'attachment_ids' | 'edit_post_id'>) {
  if (new Set(data.attachment_ids).size !== data.attachment_ids.length) fail(400, 'UPLOAD_REJECTED', '첨부 파일이 중복되었습니다.');
  for (const attachmentId of data.attachment_ids) {
    const file = await tx.one<Attachment>('SELECT * FROM attachments WHERE id=$1 FOR UPDATE', [attachmentId]);
    if (!file || file.board_id !== boardId || file.status !== 'ready' || (file.post_id && file.post_id !== data.edit_post_id) || (file.uploader_id !== p.id && (!data.edit_post_id || file.post_id !== data.edit_post_id))) fail(400, 'UPLOAD_REJECTED', '첨부 파일의 소유권과 업로드 상태를 확인해주세요.');
  }
}
async function checkEditVersion(tx: Database, data: Pick<PostDraft, 'edit_post_id' | 'edit_post_version'>) {
  if (data.edit_post_id) {
    if (!data.edit_post_version) fail(400, 'INVALID_INPUT', '편집 대상 글의 버전이 필요합니다.');
    const post = await tx.one<Post>('SELECT * FROM posts WHERE id=$1', [data.edit_post_id]);
    if (!post || post.version !== data.edit_post_version) fail(409, 'CONFLICT', '원래 글이 변경되었습니다. 초안 내용을 복사한 뒤 최신 글을 확인해주세요.');
  } else if (data.edit_post_version !== null) fail(400, 'INVALID_INPUT', '새 글 초안에는 편집 대상 버전을 지정할 수 없습니다.');
}
function normalizeDraft(row: PostDraft): PostDraft {
  const raw: unknown = row.attachment_ids;
  let ids: unknown = raw;
  if (typeof raw === 'string') { try { ids = JSON.parse(raw); } catch { fail(500, 'DRAFT_DATA_ERROR', '초안 첨부 정보를 읽지 못했습니다.'); } }
  const parsed = z.array(z.string()).max(5).safeParse(ids);
  if (!parsed.success) fail(500, 'DRAFT_DATA_ERROR', '초안 첨부 정보를 읽지 못했습니다.');
  return { ...row, attachment_ids: parsed.data };
}
function sameVersion(actual: number, expected: number) { if (actual !== expected) fail(409, 'CONFLICT', '다른 창에서 초안이 변경되었습니다. 현재 입력은 유지되며 자동 저장을 중지했습니다.'); }

/** Consumes exactly the author's saved version inside the successful post transaction. */
export async function consumeDraft(tx: Database, principal: Principal, boardId: string, data: { draft_id?: string; draft_version?: number; edit_post_id?: string | null }) {
  if (!data.draft_id && data.draft_version === undefined) return;
  if (!data.draft_id || !Number.isInteger(data.draft_version) || (data.draft_version ?? 0) < 1) fail(400, 'INVALID_INPUT', '게시할 초안 버전을 확인해주세요.');
  const draft = await tx.one<PostDraft>('SELECT * FROM post_drafts WHERE id=$1 AND board_id=$2 AND principal_id=$3 FOR UPDATE', [data.draft_id, boardId, principal.id]);
  if (!draft || draft.updated_at < cutoff()) fail(404, 'NOT_FOUND', '초안을 찾을 수 없습니다.');
  sameVersion(draft.version, data.draft_version!);
  if (draft.edit_post_id !== (data.edit_post_id ?? null)) fail(409, 'CONFLICT', '초안의 편집 대상이 일치하지 않습니다.');
  const access = await boardAccess(tx, principal, boardId); writable(access);
  if (!await allowed(tx, principal, access, draft)) fail(403, 'FORBIDDEN', '초안의 작성 권한이 변경되었습니다.');
  await checkEditVersion(tx, draft);
  await attachments(tx, principal, boardId, normalizeDraft(draft));
  await tx.run('DELETE FROM post_drafts WHERE id=$1 AND principal_id=$2 AND version=$3', [draft.id, principal.id, draft.version]);
}

export async function handleDrafts(req: Request, segments: string[]): Promise<Response | null> {
  const [resource, boardId, child, draftId] = segments;
  if (resource !== 'boards' || !boardId || child !== 'drafts' || segments.length > 4) return null;
  if (!((req.method === 'GET') || (draftId && ['PUT', 'DELETE'].includes(req.method)))) return null;
  const p = await requirePrincipal(req), db = await getDb();
  if (req.method === 'GET') {
    return json(await db.transaction(async tx => {
      const access = await lockAccess(tx, p, boardId, false);
      const rows = await tx.all<PostDraft>('SELECT * FROM post_drafts WHERE board_id=$1 AND principal_id=$2 AND updated_at>=$3 ORDER BY updated_at DESC,id LIMIT 20', [boardId, p.id, cutoff()]);
      const visible: PostDraft[] = [];
      for (const draft of rows) if ((!draftId || draft.id === draftId) && await allowed(tx, p, access, draft, false)) visible.push(normalizeDraft(draft));
      if (draftId && !visible.length) fail(404, 'NOT_FOUND', '초안을 찾을 수 없습니다.');
      return draftId ? visible[0] : visible;
    }));
  }
  if (!z.uuid().safeParse(draftId).success) fail(400, 'INVALID_INPUT', '초안 식별자가 올바르지 않습니다.');
  if (req.method === 'DELETE') {
    const data = await input(req, versionSchema);
    await db.transaction(async tx => {
      const access = await lockAccess(tx, p, boardId, false);
      const draft = await tx.one<PostDraft>('SELECT * FROM post_drafts WHERE id=$1 AND board_id=$2 AND principal_id=$3 FOR UPDATE', [draftId, boardId, p.id]);
      if (!draft || !await allowed(tx, p, access, draft, false)) fail(404, 'NOT_FOUND', '초안을 찾을 수 없습니다.');
      sameVersion(draft.version, data.version);
      await tx.run('DELETE FROM post_drafts WHERE id=$1 AND principal_id=$2', [draftId, p.id]);
    });
    return json({ deleted: true });
  }
  const data = await input(req, draftSchema);
  const saved = await db.transaction(async tx => {
    const access = await lockAccess(tx, p, boardId);
    if (!await allowed(tx, p, access, data)) fail(403, 'FORBIDDEN', '이 위치에 초안을 작성할 수 없습니다.');
    await checkEditVersion(tx, data);
    // Owner lock serializes the cross-board 20 draft limit, including anonymous sessions.
    await tx.one('SELECT id FROM principals WHERE id=$1 FOR UPDATE', [p.id]);
    const existing = await tx.one<PostDraft>('SELECT * FROM post_drafts WHERE id=$1 FOR UPDATE', [draftId]);
    if (existing && (existing.principal_id !== p.id || existing.board_id !== boardId)) fail(404, 'NOT_FOUND', '초안을 찾을 수 없습니다.');
    if (existing) {
      if (existing.updated_at < cutoff()) fail(409, 'CONFLICT', '보관 기간이 지난 초안입니다. 입력 내용을 복사한 뒤 새 초안을 작성해주세요.');
      sameVersion(existing.version, data.version);
      if (existing.edit_post_id !== data.edit_post_id || existing.edit_post_version !== data.edit_post_version) fail(409, 'CONFLICT', '초안의 편집 대상을 변경할 수 없습니다.');
    } else {
      if (data.version !== 0) fail(409, 'CONFLICT', '초안이 삭제되었거나 변경되었습니다.');
      const count = await tx.one<{ total: string }>('SELECT COUNT(*) AS total FROM post_drafts WHERE principal_id=$1 AND updated_at>=$2', [p.id, cutoff()]);
      if (Number(count?.total ?? 0) >= 20) fail(409, 'DRAFT_LIMIT', '초안은 20개까지 보관합니다. 사용하지 않는 초안을 삭제해주세요.');
      // Bounds storage when many anonymous sessions join one board; the board row is locked above.
      const onBoard = await tx.one<{ total: string }>('SELECT COUNT(*) AS total FROM post_drafts WHERE board_id=$1 AND updated_at>=$2', [boardId, cutoff()]);
      if (Number(onBoard?.total ?? 0) >= 1000) fail(409, 'DRAFT_LIMIT', '이 게시판에 보관된 초안이 너무 많습니다. 글을 게시하거나 잠시 후 다시 시도해주세요.');
    }
    await attachments(tx, p, boardId, data);
    const timestamp = now();
    const fields = [draftId, boardId, p.id, data.edit_post_id, data.section_id, data.title, data.body, data.link, data.color, JSON.stringify(data.attachment_ids), timestamp, data.edit_post_version];
    if (existing) await tx.run('UPDATE post_drafts SET section_id=$5,title=$6,body=$7,link=$8,color=$9,attachment_ids=$10::jsonb,version=version+1,updated_at=$11 WHERE id=$1 AND board_id=$2 AND principal_id=$3 AND edit_post_id IS NOT DISTINCT FROM $4 AND edit_post_version IS NOT DISTINCT FROM $12', fields);
    else await tx.run('INSERT INTO post_drafts(id,board_id,principal_id,edit_post_id,section_id,title,body,link,color,attachment_ids,created_at,updated_at,edit_post_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$11,$12)', fields);
    return normalizeDraft((await tx.one<PostDraft>('SELECT * FROM post_drafts WHERE id=$1 AND principal_id=$2', [draftId, p.id]))!);
  });
  return json(saved);
}
