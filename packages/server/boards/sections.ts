import { z } from 'zod';
import type { Principal, Section } from '@contracts';
import { audit, emit, id, now, type Database } from '@db';
import { boardAccess } from '@server/policy';
import { fail, input, json } from '@server/common/http';
import { getBoardView } from './index';

const version = z.number().int().positive();
async function lock(db: Database, actor: Principal, boardId: string, expected?: number) {
  await db.one('SELECT id FROM boards WHERE id=$1 FOR UPDATE', [boardId]);
  const access = await boardAccess(db, actor, boardId);
  if (!access.can_manage) fail(403, 'FORBIDDEN', '교사 편집 권한이 필요합니다.');
  if (expected !== undefined && access.board.version !== expected) fail(409, 'CONFLICT', '다른 변경이 있습니다. 다시 확인해주세요.');
  return access;
}
async function changed(db: Database, actor: Principal, boardId: string, action: string, target: string) {
  await db.run('UPDATE boards SET version=version+1,updated_at=$2 WHERE id=$1', [boardId, now()]);
  await emit(db, boardId, action); await audit(db, actor.id, action, target, boardId);
}
async function active(db: Database, boardId: string) { return db.all<Section>('SELECT * FROM sections WHERE board_id=$1 AND deleted_at IS NULL ORDER BY rank,id', [boardId]); }
function sameSet(actual: string[], requested: string[]) {
  if (actual.length !== requested.length || new Set(requested).size !== requested.length || requested.some(value => !actual.includes(value))) fail(400, 'INVALID_INPUT', '현재 목록에 있는 항목을 중복 없이 정렬해주세요.');
}
async function ranks(db: Database, sectionIds: string[]) {
  await db.run('UPDATE sections SET rank=((ordered.position-1)*100)::int FROM unnest($1::text[]) WITH ORDINALITY AS ordered(id,position) WHERE sections.id=ordered.id', [sectionIds]);
}

export async function handleSectionChanges(req: Request, path: string[], actor: Principal, db: Database): Promise<Response | null> {
  const [, boardId, resource, target, action] = path;
  if (resource === 'posts' && target === 'reorder' && req.method === 'POST') {
    const data = await input(req, z.object({ version, section_id: z.string().nullable(), post_ids: z.array(z.string()).max(2000) }));
    await db.transaction(async tx => {
      await lock(tx, actor, boardId, data.version);
      if (data.section_id && !await tx.one('SELECT id FROM sections WHERE id=$1 AND board_id=$2 AND deleted_at IS NULL', [data.section_id, boardId])) fail(400, 'INVALID_INPUT', '이 게시판의 섹션을 선택해주세요.');
      const posts = await tx.all<{ id: string }>("SELECT id FROM posts WHERE board_id=$1 AND section_id IS NOT DISTINCT FROM $2 AND status<>'deleted'", [boardId, data.section_id]);
      sameSet(posts.map(p => p.id), data.post_ids);
      await tx.run('UPDATE posts SET rank=((ordered.position-1)*100)::int,version=version+1,updated_at=$2 FROM unnest($1::text[]) WITH ORDINALITY AS ordered(id,position) WHERE posts.id=ordered.id', [data.post_ids, now()]);
      await changed(tx, actor, boardId, 'post.order', boardId);
    });
    return json(await getBoardView(actor, boardId));
  }
  if (resource !== 'sections') return null;
  if (target === 'reorder' && req.method === 'POST') {
    const data = await input(req, z.object({ version, section_ids: z.array(z.string()).max(100) }));
    await db.transaction(async tx => { await lock(tx, actor, boardId, data.version); const rows = await active(tx, boardId); sameSet(rows.map(s => s.id), data.section_ids); await ranks(tx, data.section_ids); await changed(tx, actor, boardId, 'section.order', boardId); });
    return json(await getBoardView(actor, boardId));
  }
  if (target && action === 'order' && req.method === 'POST') {
    const data = await input(req, z.object({ version, direction: z.enum(['up', 'down']) }));
    await db.transaction(async tx => {
      await lock(tx, actor, boardId, data.version); const rows = await active(tx, boardId); const index = rows.findIndex(s => s.id === target);
      if (index < 0) fail(404, 'NOT_FOUND', '섹션을 찾을 수 없습니다.');
      const next = index + (data.direction === 'up' ? -1 : 1);
      if (next < 0 || next >= rows.length) return;
      [rows[index], rows[next]] = [rows[next], rows[index]];
      await ranks(tx, rows.map(s => s.id)); await changed(tx, actor, boardId, 'section.order', target);
    });
    return json(await getBoardView(actor, boardId));
  }
  if (target && !action && req.method === 'DELETE') {
    const data = await input(req, z.object({ version, move_to: z.string().nullable() }));
    await db.transaction(async tx => {
      await lock(tx, actor, boardId, data.version); const rows = await active(tx, boardId);
      if (!rows.some(s => s.id === target)) fail(404, 'NOT_FOUND', '섹션을 찾을 수 없습니다.');
      if (data.move_to === target || (data.move_to && !rows.some(s => s.id === data.move_to))) fail(400, 'INVALID_INPUT', '다른 활성 섹션 또는 미분류를 선택해주세요.');
      await tx.run('UPDATE posts SET section_id=$3,version=version+1,updated_at=$4 WHERE board_id=$1 AND section_id=$2', [boardId, target, data.move_to, now()]);
      await tx.run('UPDATE post_drafts SET section_id=$3,version=version+1,updated_at=$4 WHERE board_id=$1 AND section_id=$2', [boardId, target, data.move_to, now()]);
      await tx.run('UPDATE sections SET deleted_at=$3 WHERE id=$1 AND board_id=$2', [target, boardId, now()]);
      await tx.run("UPDATE share_links SET revoked_at=$3,version=version+1 WHERE board_id=$1 AND target_type='section' AND target_id=$2 AND revoked_at IS NULL", [boardId, target, now()]);
      await changed(tx, actor, boardId, 'section.delete', target);
    });
    return json(await getBoardView(actor, boardId));
  }
  if (target && action === 'restore' && req.method === 'POST') {
    const data = await input(req, z.object({ version }));
    await db.transaction(async tx => {
      await lock(tx, actor, boardId, data.version);
      const row = await tx.one<Section>('SELECT * FROM sections WHERE id=$1 AND board_id=$2 AND deleted_at IS NOT NULL', [target, boardId]);
      if (!row) fail(404, 'NOT_FOUND', '복원할 섹션을 찾을 수 없습니다.');
      const rows = await active(tx, boardId);
      if (rows.length >= 100) fail(400, 'LIMIT_EXCEEDED', '섹션은 100개까지 사용할 수 있습니다.');
      await tx.run('UPDATE sections SET deleted_at=NULL WHERE id=$1', [target]);
      await ranks(tx,[...rows.map(s=>s.id),target]);
      await changed(tx, actor, boardId, 'section.restore', target);
    });
    return json(await getBoardView(actor, boardId));
  }
  if (!action && ((!target && req.method === 'POST') || (target && req.method === 'PATCH'))) {
    const data = await input(req, z.object({ title: z.string().trim().min(1).max(120), rank: z.number().int().min(0).max(10000).optional(), version: version.optional(), before_id: z.string().optional(), after_id: z.string().optional() }).refine(s => !(s.before_id && s.after_id), '삽입 위치 하나를 선택해주세요.'));
    await db.transaction(async tx => {
      await lock(tx, actor, boardId, data.version); const rows = await active(tx, boardId);
      if (target) {
        if (!rows.some(s => s.id === target)) fail(404, 'NOT_FOUND', '섹션을 찾을 수 없습니다.');
        await tx.run('UPDATE sections SET title=$2 WHERE id=$1', [target, data.title]); await changed(tx, actor, boardId, 'section.rename', target); return;
      }
      if (rows.length >= 100) fail(400, 'LIMIT_EXCEEDED', '섹션은 100개까지 사용할 수 있습니다.');
      const reference = data.before_id || data.after_id; const index = reference ? rows.findIndex(s => s.id === reference) : rows.length;
      if (reference && index < 0) fail(400, 'INVALID_INPUT', '현재 게시판의 삽입 위치를 선택해주세요.');
      const created = id();
      await tx.run('INSERT INTO sections(id,board_id,title,rank) VALUES($1,$2,$3,$4)', [created, boardId, data.title, data.rank ?? rows.length * 100]);
      if (reference || data.rank === undefined) { const ordered = rows.map(s => s.id); ordered.splice(index + (data.after_id ? 1 : 0), 0, created); await ranks(tx, ordered); }
      await changed(tx, actor, boardId, 'section.create', created);
    });
    return json(await getBoardView(actor, boardId));
  }
  return null;
}
