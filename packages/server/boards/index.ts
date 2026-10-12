import { z } from 'zod';
import { boardInput, postInput, type Board, type BoardView, type Post, type PostView, type Principal, type Attachment, type Section } from '@contracts';
import { getDb, id, now, emit, audit, type Database } from '@db';
import { input, fail, json } from '@server/common/http';
import { requirePrincipal } from '@server/auth';
import { consumeDraft } from '@server/drafts';
import { handleSectionChanges } from './sections';
import { boardAccess, canReadPost, canWritePost, requireTeacher } from '@server/policy';

type Access = Awaited<ReturnType<typeof boardAccess>>;
const versionInput = z.object({ version: z.number().int().positive() });
const boardPatch = z.object({
  title: z.string().trim().min(1).max(200).optional(), description: z.string().max(5000).optional(),
  column_width: z.number().int().min(260).max(440).optional(), font_scale: z.enum(['small','normal','large']).optional(), card_density: z.enum(['comfortable','compact']).optional(), background_style: z.enum(['solid','gradient','paper']).optional(),
  format: z.enum(['wall','grid','columns']).optional(), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  participation_mode: z.enum(['both','login']).optional(), moderation: z.boolean().optional(), anonymous_display: z.boolean().optional(),
  version: z.number().int().positive(), state: z.enum(['draft', 'open', 'closed', 'archived']).optional(),
  allow_comments: z.boolean().optional(), allow_reactions: z.boolean().optional(),
});
const postPatch = z.object({
  version: z.number().int().positive(), title: z.string().trim().min(1).max(200).optional(), body: z.string().max(10000).optional(),
  section_id: z.string().nullable().optional(), link: z.union([z.url().refine(value => /^https?:\/\//.test(value)),z.literal('')]).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), attachment_ids: z.array(z.string()).max(5).optional(),
  rank: z.number().int().min(0).max(2147483647).optional(), draft_id:z.uuid().optional(),draft_version:z.number().int().positive().optional(),
});
function managed(access: Access) { if (!access.can_manage) fail(403, 'FORBIDDEN', '교사 편집 권한이 필요합니다.'); }
function writable(access: Access) { if (!access.can_write) fail(403, access.board.state !== 'open' ? 'BOARD_CLOSED' : 'FORBIDDEN', '현재 이 활동에 작성할 수 없습니다.'); }
function owner(p: Principal, board: Board) { if (board.owner_id !== p.id) fail(403, 'FORBIDDEN', '소유 교사만 할 수 있는 작업입니다.'); }
function checkVersion(actual: number, expected: number) { if (actual !== expected) fail(409, 'CONFLICT', '다른 변경이 있습니다. 새로고침 후 다시 시도해주세요.'); }
function key(req: Request, prefix: string) {
  const value = req.headers.get('idempotency-key');
  if (!value) return null;
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(value)) fail(400, 'INVALID_INPUT', '올바른 재시도 키가 필요합니다.');
  return `${prefix}:${value}`;
}
async function touch(tx: Database, boardId: string, kind = 'changed') {
  await tx.run('UPDATE boards SET version=version+1,updated_at=$2 WHERE id=$1', [boardId, now()]);
  await emit(tx, boardId, kind);
}
async function lockAccess(tx: Database, p: Principal, boardId: string) {
  await tx.one('SELECT id FROM boards WHERE id=$1 FOR UPDATE', [boardId]);
  return boardAccess(tx, p, boardId);
}
async function limit(tx: Database, principal: Principal, boardId: string, kind: string, max: number) {
  const current = now();
  const row = await tx.one<{ count: number }>(`INSERT INTO rate_limits(key,count,resets_at) VALUES($1,1,$2)
    ON CONFLICT(key) DO UPDATE SET count=CASE WHEN rate_limits.resets_at < $3 THEN 1 ELSE rate_limits.count+1 END,
    resets_at=CASE WHEN rate_limits.resets_at < $3 THEN $2 ELSE rate_limits.resets_at END RETURNING count`,
  [`${kind}:${principal.id}:${boardId}`, new Date(Date.now() + 60000).toISOString(), current]);
  if (row && row.count > max) fail(429, 'RATE_LIMITED', '잠시 기다린 후 다시 작성해주세요.');
}
async function section(tx: Database, boardId: string, sectionId: string | null | undefined) {
  if (sectionId && !await tx.one('SELECT id FROM sections WHERE id=$1 AND board_id=$2 AND deleted_at IS NULL', [sectionId, boardId])) fail(400, 'INVALID_INPUT', '이 게시판의 섹션을 선택해주세요.');
}
const MAX_RANK = 2147483647;
/** Appends after the last post in the section. Legacy timestamp ranks near the INTEGER limit are renumbered first (caller holds the board lock). */
async function nextRank(tx: Database, boardId: string, sectionId: string | null) {
  const where = "board_id=$1 AND section_id IS NOT DISTINCT FROM $2 AND status<>'deleted'";
  const top = Number((await tx.one<{ top: number | null }>(`SELECT max(rank) AS top FROM posts WHERE ${where}`, [boardId, sectionId]))?.top ?? -100);
  if (top <= MAX_RANK - 100) return top + 100;
  const ordered = await tx.all<{ id: string }>(`SELECT id FROM posts WHERE ${where} ORDER BY rank,created_at,id`, [boardId, sectionId]);
  await tx.run('UPDATE posts SET rank=((ordered.position-1)*100)::int FROM unnest($1::text[]) WITH ORDINALITY AS ordered(id,position) WHERE posts.id=ordered.id', [ordered.map(post => post.id)]);
  return ordered.length * 100;
}
function canCreate(access: Access, sectionId: string | null | undefined) {
  writable(access);
  if (!access.can_manage && !access.shares.some(s => s.scope === 'write' && (s.target_type === 'board' || s.target_type === 'submission' || (s.target_type === 'section' && s.target_id === sectionId)))) {
    fail(403, 'FORBIDDEN', '이 공유 링크는 새 글을 작성할 수 있는 범위가 아닙니다.');
  }
}
function writePost(access: Access, p: Principal, post: Post) {
  if (post.board_id !== access.board.id || !canReadPost(access, p, post)) fail(404, 'NOT_FOUND', '글을 찾을 수 없습니다.');
  writable(access);
  if (!canWritePost(access, p, post)) fail(403, 'FORBIDDEN', '이 글에는 쓰기 권한이 없습니다.');
  if (!access.can_manage && post.author_id !== p.id) fail(403, 'FORBIDDEN', '본인이 작성한 글만 수정할 수 있습니다.');
}
async function attach(tx: Database, p: Principal, boardId: string, postId: string, attachmentIds: string[]) {
  const unique = [...new Set(attachmentIds)];
  for (const attachmentId of unique) {
    const file = await tx.one<Attachment>('SELECT * FROM attachments WHERE id=$1 FOR UPDATE', [attachmentId]);
    if (!file || file.board_id !== boardId || file.status !== 'ready' || (file.post_id && file.post_id !== postId) || (file.uploader_id !== p.id && file.post_id !== postId)) fail(400, 'UPLOAD_REJECTED', '첨부 파일의 소유권과 업로드 상태를 확인해주세요.');
  }
  const current = await tx.all<Attachment>('SELECT * FROM attachments WHERE post_id=$1', [postId]);
  for (const file of current) if (!unique.includes(file.id)) await tx.run('UPDATE attachments SET post_id=NULL WHERE id=$1', [file.id]);
  for (const attachmentId of unique) await tx.run('UPDATE attachments SET post_id=$2 WHERE id=$1', [attachmentId, postId]);
}

async function view(db: Database, p: Principal, access: Access): Promise<BoardView> {
  const sections = await db.all<Section>('SELECT * FROM sections WHERE board_id=$1 AND deleted_at IS NULL ORDER BY rank,id', [access.board.id]);
  const records = (await db.all<Post & { display_name: string }>('SELECT posts.*,principals.display_name FROM posts JOIN principals ON principals.id=posts.author_id WHERE board_id=$1 ORDER BY rank,created_at,id', [access.board.id])).filter(post => canReadPost(access, p, post));
  const visibleIds = records.map(post => post.id);
  type CommentRow = { id: string; post_id: string; body: string; author_id: string; display_name: string; created_at: string };
  type AttachmentRow = Pick<Attachment, 'id' | 'name' | 'mime' | 'bytes' | 'status'> & { post_id: string };
  const comments = visibleIds.length ? await db.all<CommentRow>('SELECT comments.*,principals.display_name FROM comments JOIN principals ON principals.id=comments.author_id WHERE post_id=ANY($1::text[]) ORDER BY created_at,id', [visibleIds]) : [];
  const likes = visibleIds.length ? await db.all<{ post_id: string; total: string; liked: boolean }>('SELECT post_id,COUNT(*) AS total,BOOL_OR(principal_id=$2) AS liked FROM reactions WHERE post_id=ANY($1::text[]) GROUP BY post_id', [visibleIds, p.id]) : [];
  const attachments = visibleIds.length ? await db.all<AttachmentRow>('SELECT post_id,id,name,mime,bytes,status FROM attachments WHERE post_id=ANY($1::text[]) AND status=$2 ORDER BY created_at,id', [visibleIds, 'ready']) : [];
  const name = (displayName: string, mine: boolean) => access.can_manage || !access.board.anonymous_display ? displayName : mine ? '나' : '익명 참여자';
  const posts: PostView[] = records.map(record => {
    const { author_id, display_name, ...post } = record;
    const reaction = likes.find(item => item.post_id === post.id);
    return { ...post, author_name: name(display_name, author_id === p.id), is_mine: author_id === p.id, can_edit: canWritePost(access, p, record) && (access.can_manage || author_id === p.id), likes: Number(reaction?.total ?? 0), liked: reaction?.liked ?? false,
      attachments: attachments.filter(file => file.post_id === post.id).map(({ post_id: _postId, ...file }) => file),
      comments: comments.filter(comment => comment.post_id === post.id).map(({ author_id: commentAuthor, display_name: commentName, post_id: _postId, ...comment }) => ({ ...comment, author_name: name(commentName, commentAuthor === p.id), is_mine: commentAuthor === p.id })) };
  });
  const deleted_sections = access.can_manage ? await db.all<Section>('SELECT * FROM sections WHERE board_id=$1 AND deleted_at IS NOT NULL ORDER BY deleted_at DESC',[access.board.id]) : undefined;
  return { board: access.board, sections, ...(deleted_sections ? {deleted_sections} : {}), posts, can_manage: access.can_manage, can_write: access.can_write, submission_only: access.submission_only, principal: { id: p.id, role: p.role, display_name: p.display_name } };
}
export async function getBoardView(principal: Principal, boardId: string): Promise<BoardView> {
  const db = await getDb();
  return db.transaction(async tx => view(tx, principal, await lockAccess(tx, principal, boardId)));
}

async function createBoard(tx: Database, p: Principal, data: z.infer<typeof boardInput>, source?: Board) {
  const boardId = id(), timestamp = now();
  await tx.run(`INSERT INTO boards(id,owner_id,title,description,format,state,participation_mode,moderation,anonymous_display,color,created_at,updated_at,allow_comments,allow_reactions)
    VALUES($1,$2,$3,$4,$5,'draft',$6,$7,$8,$9,$10,$10,$11,$12)`, [boardId, p.id, data.title, data.description, data.format, data.participation_mode, data.moderation, data.anonymous_display, data.color, timestamp, source?.allow_comments ?? true, source?.allow_reactions ?? true]);
  if (!source) await tx.run('INSERT INTO sections(id,board_id,title,rank) VALUES($1,$2,$3,0)', [id(), boardId, '우리의 생각']);
  await emit(tx, boardId, 'created');
  await audit(tx, p.id, 'board.create', boardId);
  return boardId;
}

export async function handleBoards(req: Request, segments: string[]): Promise<Response | null> {
  const [resource, resourceId, child, childId] = segments;
  if (!['boards', 'posts'].includes(resource ?? '')) return null;
  // The media, export, sharing and SSE routes are owned by integration modules.
  if (resource === 'boards' && child && !['posts', 'sections', 'favorite', 'restore', 'duplicate', 'members'].includes(child)) return null;
  const p = await requirePrincipal(req), db = await getDb();
  if (resource === 'boards' && resourceId && (child === 'sections' || (child === 'posts' && childId === 'reorder'))) return handleSectionChanges(req, segments, p, db);
  if (resource === 'boards' && !resourceId) {
    requireTeacher(p);
    if (req.method === 'GET') {
      const url = new URL(req.url), search = (url.searchParams.get('q') ?? '').slice(0, 200), trash = url.searchParams.get('trash') === 'true';
      const cursor = url.searchParams.get('cursor') ?? null;
      const rows = await db.all<Board & { favorite: boolean; post_count: string }>(`SELECT b.*,EXISTS(SELECT 1 FROM favorites f WHERE f.board_id=b.id AND f.principal_id=$1) AS favorite,
        (SELECT COUNT(*) FROM posts WHERE board_id=b.id AND status<>'deleted') AS post_count FROM boards b WHERE
        (b.owner_id=$1 OR EXISTS(SELECT 1 FROM board_members m WHERE m.board_id=b.id AND m.principal_id=$1))
        AND (CASE WHEN $2 THEN b.deleted_at IS NOT NULL ELSE b.deleted_at IS NULL END)
        AND (b.title ILIKE $3 OR b.description ILIKE $3) AND ($4::text IS NULL OR (b.updated_at || ':' || b.id) < $4)
        ORDER BY b.updated_at DESC,b.id DESC LIMIT 51`, [p.id, trash, `%${search}%`, cursor]);
      const list = rows.slice(0, 50);
      return json({ boards: list.map(row => ({ ...row, post_count: Number(row.post_count) })), next_cursor: rows.length > 50 ? `${list[list.length - 1].updated_at}:${list[list.length - 1].id}` : null });
    }
    if (req.method === 'POST') {
      const data = await input(req, boardInput);
      const boardId = await db.transaction(tx => createBoard(tx, p, data));
      return json(await getBoardView(p, boardId), 201);
    }
    return null;
  }
  if (resource === 'boards' && resourceId) {
    if (!child && req.method === 'GET') return json(await getBoardView(p, resourceId));
    if (!child && req.method === 'PATCH') {
      const { version, ...data } = await input(req, boardPatch);
      await db.transaction(async tx => {
        const access = await lockAccess(tx, p, resourceId); managed(access); checkVersion(access.board.version, version);
        const entries = Object.entries(data).filter(([, value]) => value !== undefined);
        if (!entries.length) return;
        const lifecycle: Record<Board['state'], Board['state'][]> = { draft: ['draft', 'open'], open: ['open', 'closed'], closed: ['closed', 'open', 'archived'], archived: ['archived', 'closed', 'open'] };
        if (data.state && !lifecycle[access.board.state].includes(data.state)) fail(400, 'INVALID_INPUT', '허용되지 않은 게시판 상태 변경입니다.');
        await tx.run(`UPDATE boards SET ${entries.map(([field], i) => `${field}=$${i + 2}`).join(',')},version=version+1,updated_at=$${entries.length + 2} WHERE id=$1`, [resourceId, ...entries.map(([, value]) => value), now()]);
        await emit(tx, resourceId, 'settings'); await audit(tx, p.id, 'board.update', resourceId);
      });
      return json(await getBoardView(p, resourceId));
    }
    if (!child && req.method === 'DELETE') {
      const { version } = await input(req, versionInput);
      await db.transaction(async tx => { const access = await lockAccess(tx, p, resourceId); owner(p, access.board); checkVersion(access.board.version, version); await tx.run('UPDATE boards SET deleted_at=$2,updated_at=$2,version=version+1 WHERE id=$1', [resourceId, now()]); await emit(tx, resourceId, 'deleted'); await audit(tx, p.id, 'board.delete', resourceId); });
      return json({ deleted: true });
    }
    if (child === 'restore' && req.method === 'POST') {
      requireTeacher(p);
      const { version } = await input(req, versionInput);
      await db.transaction(async tx => { const board = await tx.one<Board>('SELECT * FROM boards WHERE id=$1 FOR UPDATE', [resourceId]); if (!board) fail(404, 'NOT_FOUND', '게시판을 찾을 수 없습니다.'); owner(p, board); checkVersion(board.version, version); await tx.run("UPDATE boards SET deleted_at=NULL,state='closed',updated_at=$2,version=version+1 WHERE id=$1", [resourceId, now()]); await emit(tx, resourceId, 'restored'); await audit(tx, p.id, 'board.restore', resourceId); });
      return json(await getBoardView(p, resourceId));
    }
    if (child === 'duplicate' && req.method === 'POST') {
      requireTeacher(p);
      const data = await input(req, z.object({ include_posts: z.boolean().default(false) }));
      const duplicateId = await db.transaction(async tx => {
        const access = await lockAccess(tx, p, resourceId); managed(access);
        const source = access.board, duplicate = await createBoard(tx, p, { title: `${source.title.slice(0, 193)} 사본`, description: source.description, format: source.format, color: source.color, participation_mode: source.participation_mode, moderation: source.moderation, anonymous_display: source.anonymous_display }, source);
        await tx.run('UPDATE boards SET column_width=$2,font_scale=$3,card_density=$4,background_style=$5 WHERE id=$1',[duplicate,source.column_width??300,source.font_scale??'normal',source.card_density??'comfortable',source.background_style??'gradient']);
        const mapping = new Map<string, string>();
        for (const item of await tx.all<Section>('SELECT * FROM sections WHERE board_id=$1 AND deleted_at IS NULL', [resourceId])) { const sectionId = id(); mapping.set(item.id, sectionId); await tx.run('INSERT INTO sections(id,board_id,title,rank) VALUES($1,$2,$3,$4)', [sectionId, duplicate, item.title, item.rank]); }
        if (data.include_posts) for (const post of await tx.all<Post>("SELECT * FROM posts WHERE board_id=$1 AND status='published'", [resourceId])) await tx.run("INSERT INTO posts(id,board_id,section_id,author_id,title,body,link,status,color,rank,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,'published',$8,$9,$10,$10)", [id(), duplicate, post.section_id ? mapping.get(post.section_id) ?? null : null, p.id, post.title, post.body, post.link, post.color, post.rank, now()]);
        return duplicate;
      });
      return json(await getBoardView(p, duplicateId), 201);
    }
    if (child === 'favorite' && req.method === 'PUT') {
      requireTeacher(p); const data = await input(req, z.object({ favorite: z.boolean() }));
      await db.transaction(async tx => { await lockAccess(tx, p, resourceId); if (data.favorite) await tx.run('INSERT INTO favorites(principal_id,board_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [p.id, resourceId]); else await tx.run('DELETE FROM favorites WHERE principal_id=$1 AND board_id=$2', [p.id, resourceId]); });
      return json(data);
    }
    if (child === 'members' && req.method === 'POST') {
      const data = await input(req, z.object({ email: z.email() }));
      await db.transaction(async tx => { const access = await lockAccess(tx, p, resourceId); owner(p, access.board); const teacher = await tx.one<Principal>("SELECT * FROM principals WHERE LOWER(email)=LOWER($1) AND role IN ('teacher','admin') AND disabled_at IS NULL", [data.email]); if (!teacher) fail(400, 'INVALID_INPUT', '먼저 로그인한 학교 교사 계정을 입력해주세요.'); if (teacher.id === p.id) fail(400, 'INVALID_INPUT', '이미 소유 교사입니다.'); await tx.run("INSERT INTO board_members(board_id,principal_id,role) VALUES($1,$2,'editor') ON CONFLICT(board_id,principal_id) DO UPDATE SET role='editor'", [resourceId, teacher.id]); await touch(tx, resourceId, 'member'); await audit(tx, p.id, 'board.invite_editor', resourceId); });
      return json({ invited: true });
    }
    if (child === 'posts' && req.method === 'GET') return json((await getBoardView(p, resourceId)).posts);
    if (child === 'posts' && req.method === 'POST') {
      const data = await input(req, postInput), idem = key(req, `post:${resourceId}`);
      const postId = await db.transaction(async tx => {
        const access = await lockAccess(tx, p, resourceId); canCreate(access, data.section_id); await section(tx, resourceId, data.section_id);
        if (idem) { const prior = await tx.one<{ result_id: string }>('SELECT result_id FROM idempotency WHERE principal_id=$1 AND key=$2', [p.id, idem]); if (prior) { const existing = await tx.one<Post>('SELECT * FROM posts WHERE id=$1', [prior.result_id]); if (!existing || existing.board_id !== resourceId || existing.author_id !== p.id || existing.title !== data.title || existing.body !== data.body || existing.link !== (data.link || null) || existing.section_id !== (data.section_id ?? null) || existing.color !== data.color) fail(409, 'CONFLICT', '같은 재시도 키로 다른 글을 작성할 수 없습니다.'); const files = await tx.all<{id:string}>('SELECT id FROM attachments WHERE post_id=$1', [existing.id]); if (JSON.stringify(files.map(file => file.id).sort()) !== JSON.stringify([...new Set(data.attachment_ids)].sort())) fail(409, 'CONFLICT', '같은 재시도 키로 첨부 파일을 바꿀 수 없습니다.'); return existing.id; } }
        await consumeDraft(tx,p,resourceId,{draft_id:data.draft_id,draft_version:data.draft_version,edit_post_id:null});
        await limit(tx, p, resourceId, 'post', 10);
        const postId = id(), timestamp = now(), status = access.board.moderation && !access.can_manage ? 'pending' : 'published';
        await tx.run('INSERT INTO posts(id,board_id,section_id,author_id,title,body,link,status,color,rank,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)', [postId, resourceId, data.section_id ?? null, p.id, data.title, data.body, data.link || null, status, data.color, await nextRank(tx, resourceId, data.section_id ?? null), timestamp]);
        await attach(tx, p, resourceId, postId, data.attachment_ids);
        if (idem) await tx.run('INSERT INTO idempotency(principal_id,key,result_id,created_at) VALUES($1,$2,$3,$4)', [p.id, idem, postId, timestamp]);
        await touch(tx, resourceId, 'post'); return postId;
      });
      return json({ post_id: postId, view: await getBoardView(p, resourceId) }, 201);
    }
    return null;
  }
  if (resource === 'posts' && resourceId) {
    const original = await db.one<Post>('SELECT * FROM posts WHERE id=$1', [resourceId]);
    if (!original) fail(404, 'NOT_FOUND', '글을 찾을 수 없습니다.');
    if (!child && req.method === 'GET') { const data = await getBoardView(p, original.board_id); const post = data.posts.find(item => item.id === resourceId); if (!post) fail(404, 'NOT_FOUND', '글을 찾을 수 없습니다.'); return json(post); }
    if (child === 'order' && req.method === 'POST') {
      const data = await input(req, z.object({ version: z.number().int().positive(), direction: z.enum(['up', 'down']) }));
      await db.transaction(async tx => {
        const access = await lockAccess(tx, p, original.board_id); managed(access);
        const post = await tx.one<Post>('SELECT * FROM posts WHERE id=$1 FOR UPDATE', [resourceId]);
        if (!post || post.status === 'deleted') fail(404, 'NOT_FOUND', '글을 찾을 수 없습니다.');
        checkVersion(post.version, data.version);
        const ordered = await tx.all<Post>("SELECT * FROM posts WHERE board_id=$1 AND section_id IS NOT DISTINCT FROM $2 AND status<>'deleted' ORDER BY rank,created_at,id", [original.board_id, post.section_id]);
        const index = ordered.findIndex(item => item.id === resourceId), nextIndex = index + (data.direction === 'up' ? -1 : 1);
        if (nextIndex < 0 || nextIndex >= ordered.length) return;
        [ordered[index], ordered[nextIndex]] = [ordered[nextIndex], ordered[index]];
        for (let i = 0; i < ordered.length; i++) if (ordered[i].rank !== i * 100) await tx.run('UPDATE posts SET rank=$2,version=version+1,updated_at=$3 WHERE id=$1', [ordered[i].id, i * 100, now()]);
        await touch(tx, original.board_id, 'order');
      });
      return json(await getBoardView(p, original.board_id));
    }
    if (!child && req.method === 'PATCH') {
      const patch = await input(req, postPatch);
      await db.transaction(async tx => {
        const access = await lockAccess(tx, p, original.board_id);
        const post = await tx.one<Post>('SELECT * FROM posts WHERE id=$1 FOR UPDATE', [resourceId]);
        if (!post) fail(404, 'NOT_FOUND', '글을 찾을 수 없습니다.');
        writePost(access, p, post); checkVersion(post.version, patch.version);
        await consumeDraft(tx,p,original.board_id,{draft_id:patch.draft_id,draft_version:patch.draft_version,edit_post_id:post.id});
        if (patch.rank !== undefined && !access.can_manage) fail(403, 'FORBIDDEN', '정렬은 교사만 변경할 수 있습니다.');
        const data = { ...post, ...patch };
        await section(tx, original.board_id, data.section_id);
        if (!access.can_manage && data.section_id !== post.section_id && !access.shares.some(s => s.scope === 'write' && (s.target_type === 'board' || s.target_type === 'submission' || (s.target_type === 'section' && s.target_id === data.section_id)))) fail(403, 'FORBIDDEN', '이 섹션으로 이동할 수 없습니다.');
        await tx.run('UPDATE posts SET title=$2,body=$3,section_id=$4,link=$5,color=$6,status=$7,version=version+1,updated_at=$8,rank=$9 WHERE id=$1', [resourceId, data.title, data.body, data.section_id, data.link || null, data.color, access.board.moderation && !access.can_manage ? 'pending' : post.status, now(), data.rank]);
        if (patch.attachment_ids !== undefined) await attach(tx, p, original.board_id, resourceId, patch.attachment_ids);
        await touch(tx, original.board_id, 'post');
      });
      return json(await getBoardView(p, original.board_id));
    }
    if (!child && req.method === 'DELETE') {
      const data = await input(req, versionInput);
      await db.transaction(async tx => { const access = await lockAccess(tx, p, original.board_id); const post = await tx.one<Post>('SELECT * FROM posts WHERE id=$1 FOR UPDATE', [resourceId]); if (!post) fail(404, 'NOT_FOUND', '글을 찾을 수 없습니다.'); writePost(access, p, post); checkVersion(post.version, data.version); await tx.run("UPDATE posts SET status='deleted',version=version+1,updated_at=$2 WHERE id=$1", [resourceId, now()]); await touch(tx, original.board_id, 'post'); });
      return json(await getBoardView(p, original.board_id));
    }
    if (child === 'moderation' && req.method === 'POST') {
      const data = await input(req, z.object({ version: z.number().int().positive(), status: z.enum(['published', 'rejected', 'hidden']) }));
      await db.transaction(async tx => { const access = await lockAccess(tx, p, original.board_id); managed(access); const post = await tx.one<Post>('SELECT * FROM posts WHERE id=$1 FOR UPDATE', [resourceId]); if (!post || post.status === 'deleted') fail(404, 'NOT_FOUND', '글을 찾을 수 없습니다.'); checkVersion(post.version, data.version); await tx.run('UPDATE posts SET status=$2,version=version+1,updated_at=$3 WHERE id=$1', [resourceId, data.status, now()]); await touch(tx, original.board_id, 'moderation'); await audit(tx, p.id, `post.${data.status}`, resourceId); });
      return json(await getBoardView(p, original.board_id));
    }
    if (child === 'comments' && req.method === 'POST') {
      const data = await input(req, z.object({ body: z.string().trim().min(1).max(2000) })), idem = key(req, `comment:${resourceId}`);
      await db.transaction(async tx => { const access = await lockAccess(tx, p, original.board_id); const post = await tx.one<Post>('SELECT * FROM posts WHERE id=$1', [resourceId]); if (!post || !canReadPost(access, p, post)) fail(404, 'NOT_FOUND', '글을 찾을 수 없습니다.'); writable(access); if (!canWritePost(access, p, post)) fail(403, 'FORBIDDEN', '이 글에는 댓글 작성 권한이 없습니다.'); if (!access.board.allow_comments) fail(403, 'FORBIDDEN', '댓글이 꺼져 있습니다.'); if (idem && await tx.one('SELECT result_id FROM idempotency WHERE principal_id=$1 AND key=$2', [p.id, idem])) return; await limit(tx, p, original.board_id, 'comment', 30); const commentId = id(); await tx.run('INSERT INTO comments(id,post_id,author_id,body,created_at) VALUES($1,$2,$3,$4,$5)', [commentId, resourceId, p.id, data.body, now()]); if (idem) await tx.run('INSERT INTO idempotency(principal_id,key,result_id,created_at) VALUES($1,$2,$3,$4)', [p.id, idem, commentId, now()]); await touch(tx, original.board_id, 'comment'); });
      return json(await getBoardView(p, original.board_id));
    }
    if (child === 'reaction' && req.method === 'PUT') {
      const data = await input(req, z.object({ liked: z.boolean() }));
      await db.transaction(async tx => { const access = await lockAccess(tx, p, original.board_id); const post = await tx.one<Post>('SELECT * FROM posts WHERE id=$1', [resourceId]); if (!post || !canReadPost(access, p, post)) fail(404, 'NOT_FOUND', '글을 찾을 수 없습니다.'); writable(access); if (!canWritePost(access, p, post)) fail(403, 'FORBIDDEN', '이 글에는 반응 권한이 없습니다.'); if (!access.board.allow_reactions) fail(403, 'FORBIDDEN', '좋아요가 꺼져 있습니다.'); if (data.liked) await tx.run('INSERT INTO reactions(post_id,principal_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [resourceId, p.id]); else await tx.run('DELETE FROM reactions WHERE post_id=$1 AND principal_id=$2', [resourceId, p.id]); await touch(tx, original.board_id, 'reaction'); });
      return json(await getBoardView(p, original.board_id));
    }
  }
  return null;
}
