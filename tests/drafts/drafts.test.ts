import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import type { BoardView, PostDraft, Principal, Share } from '@contracts';
import { getDb, id, now, type Database } from '@db';
import { createAnonymousSession } from '@server/auth';
import { handleBoards } from '@server/boards';
import { consumeDraft, handleDrafts } from '@server/drafts';
let db: Database, teacher: Principal, student: Principal, other: Principal, teacherCookie: string, studentCookie: string, otherCookie: string, board: BoardView;
async function call<T = PostDraft>(path: string, value?: unknown, cookie = studentCookie, method = value === undefined ? 'GET' : 'PUT'): Promise<T> {
 const request = new Request(`http://localhost:3000/api/${path}`, { method, headers: { cookie, 'Content-Type': 'application/json' }, ...(value !== undefined ? { body: JSON.stringify(value) } : {}) });
 const response = await handleDrafts(request, path.split('/')); expect(response).not.toBeNull(); return (await response!.json()).data;
}
const path = (draftId?: string) => `boards/${board.board.id}/drafts${draftId ? `/${draftId}` : ''}`;
const payload = (extra = {}) => ({ version: 0, section_id: board.sections[0].id, title: '합성 초안', body: '실제 학생 자료 없음', ...extra });
async function grant(p: Principal, type: Share['target_type'] = 'board', target = board.board.id, scope: Share['scope'] = 'write') {
 const shareId = id(); await db.run('INSERT INTO share_links(id,board_id,target_type,target_id,scope,token_hash,code_hash,expires_at,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)', [shareId, board.board.id, type, target, scope, id(), id(), new Date(Date.now()+3600000).toISOString(), now()]);
 await db.run('INSERT INTO participations(id,principal_id,board_id,share_id,share_version,created_at) VALUES($1,$2,$3,$4,1,$5)', [id(), p.id, board.board.id, shareId, now()]); return shareId;
}
async function readyFile(owner = student.id) { const file = id(); await db.run("INSERT INTO attachments(id,board_id,uploader_id,name,mime,bytes,storage_key,status,created_at) VALUES($1,$2,$3,'합성 이미지','image/png',10,$4,'ready',$5)", [file, board.board.id, owner, id(), now()]); return file; }
beforeAll(async () => { db = await getDb(); });
beforeEach(async () => {
 teacher = { id: id(), role: 'teacher', display_name: '합성 교사', email: `${id()}@samjeong.ms.kr`, disabled_at: null, provider_subject: id(), created_at: now() };
 await db.run('INSERT INTO principals(id,role,display_name,email,provider_subject,created_at) VALUES($1,$2,$3,$4,$5,$6)', [teacher.id,teacher.role,teacher.display_name,teacher.email,teacher.provider_subject,teacher.created_at]);
 const token = randomBytes(32).toString('base64url'); teacherCookie = `samjeong_session=${token}`;
 await db.run('INSERT INTO sessions(id,principal_id,token_hash,expires_at,created_at) VALUES($1,$2,$3,$4,$5)', [id(),teacher.id,createHash('sha256').update(token).digest('hex'),new Date(Date.now()+3600000).toISOString(),now()]);
 const a=await createAnonymousSession('합성A'), b=await createAnonymousSession('합성B'); student=a.principal;studentCookie=a.cookie;other=b.principal;otherCookie=b.cookie;
 const response=await handleBoards(new Request('http://localhost:3000/api/boards',{method:'POST',headers:{cookie:teacherCookie,'Content-Type':'application/json'},body:JSON.stringify({title:'합성 초안 수업',format:'columns'})}),['boards']); board=(await response!.json()).data;
 await db.run("UPDATE boards SET state='open' WHERE id=$1",[board.board.id]); await grant(student); await grant(other);
});
describe('private server drafts', () => {
 it('restores anonymous drafts only for their owner and does not emit content or events', async () => {
  const draftId=id(); const saved=await call(path(draftId),payload()); expect(saved.version).toBe(1); expect(saved.principal_id).toBe(student.id);
  expect(await call<PostDraft[]>(path())).toHaveLength(1); expect(await call<PostDraft[]>(path(),undefined,otherCookie)).toEqual([]); expect(await call<PostDraft[]>(path(),undefined,teacherCookie)).toEqual([]);
  await expect(call(path(draftId),undefined,otherCookie)).rejects.toMatchObject({status:404});
  await expect(call(path(draftId),payload({version:1}),otherCookie)).rejects.toMatchObject({status:404});
  expect(await db.one('SELECT 1 FROM audit_events WHERE target_id=$1',[draftId])).toBeNull();
  expect(await db.one('SELECT 1 FROM outbox_events WHERE board_id=$1 AND event_type LIKE $2',[board.board.id,'%draft%'])).toBeNull();
 });
 it('uses compare and swap for updates and deletion without losing the latest body', async () => {
  const draftId=id(); await call(path(draftId),payload()); const next=await call(path(draftId),payload({version:1,body:'새 합성 내용'}));expect(next.version).toBe(2);
  await expect(call(path(draftId),payload({version:1,body:'오래된 내용'}))).rejects.toMatchObject({status:409});
  await expect(call(path(draftId),{version:1},studentCookie,'DELETE')).rejects.toMatchObject({status:409});
  expect((await call(path(draftId))).body).toBe('새 합성 내용'); await call(path(draftId),{version:2},studentCookie,'DELETE'); expect(await call<PostDraft[]>(path())).toEqual([]);
 });
 it('limits saved drafts to twenty per owner across boards and validates lengths', async () => {
  for(let i=0;i<20;i++) await call(path(id()),payload({title:`합성 ${i}`}));
  await expect(call(path(id()),payload())).rejects.toMatchObject({code:'DRAFT_LIMIT'});
  await expect(call(path(id()),payload({body:'x'.repeat(10001)}))).rejects.toMatchObject({status:400});
 });
 it('preserves incomplete title and links while rejecting foreign or unready attachments', async () => {
  const own=await readyFile(),foreign=await readyFile(other.id),draftId=id();
  expect((await call(path(draftId),payload({title:'',link:'https://',attachment_ids:[own]}))).attachment_ids).toEqual([own]);
  await expect(call(path(id()),payload({attachment_ids:[foreign]}))).rejects.toMatchObject({code:'UPLOAD_REJECTED'});
  await db.run("UPDATE attachments SET status='quarantined' WHERE id=$1",[own]); await expect(call(path(draftId),payload({version:1,attachment_ids:[own]}))).rejects.toMatchObject({code:'UPLOAD_REJECTED'});
 });
 it('does not broaden a section grant or allow a post-only grant to create drafts', async () => {
  const sectionId=id();await db.run('INSERT INTO sections(id,board_id,title) VALUES($1,$2,$3)',[sectionId,board.board.id,'다른 합성 모둠']);
  await db.run('DELETE FROM participations WHERE principal_id=$1',[student.id]);await grant(student,'section',board.sections[0].id);
  await call(path(id()),payload());await expect(call(path(id()),payload({section_id:sectionId}))).rejects.toMatchObject({status:403});
  await db.run('DELETE FROM participations WHERE principal_id=$1',[student.id]);await grant(student,'board',board.board.id,'read');
  await expect(call(path(id()),payload())).rejects.toMatchObject({status:403});
 });
 it('permits reading own drafts after closing but blocks saving and revoked access', async () => {
  const draftId=id();await call(path(draftId),payload());await db.run("UPDATE boards SET state='closed' WHERE id=$1",[board.board.id]);
  expect((await call(path(draftId))).id).toBe(draftId);await expect(call(path(draftId),payload({version:1}))).rejects.toMatchObject({code:'BOARD_CLOSED'});
  await db.run('DELETE FROM participations WHERE principal_id=$1',[student.id]);await expect(call(path(draftId))).rejects.toMatchObject({status:404});
 });
 it('excludes expired drafts, prevents edit target theft and locks their target', async () => {
  const draftId=id();await call(path(draftId),payload());await db.run('UPDATE post_drafts SET updated_at=$2 WHERE id=$1',[draftId,new Date(Date.now()-15*86400000).toISOString()]);
  expect(await call<PostDraft[]>(path())).toEqual([]);await expect(call(path(draftId),payload({version:1}))).rejects.toMatchObject({status:409});
  const postId=id();await db.run("INSERT INTO posts(id,board_id,section_id,author_id,title,status,created_at,updated_at) VALUES($1,$2,$3,$4,'합성 타인 글','published',$5,$5)",[postId,board.board.id,board.sections[0].id,other.id,now()]);
  await expect(call(path(id()),payload({edit_post_id:postId}))).rejects.toMatchObject({status:403});
 });
 it('preserves an edit draft baseline and conflicts when the original post changes', async () => {
  const postId=id();await db.run("INSERT INTO posts(id,board_id,section_id,author_id,title,status,created_at,updated_at) VALUES($1,$2,$3,$4,'합성 편집 대상','published',$5,$5)",[postId,board.board.id,board.sections[0].id,student.id,now()]);
  const draftId=id();await expect(call(path(draftId),payload({edit_post_id:postId}))).rejects.toMatchObject({status:400});await call(path(draftId),payload({edit_post_id:postId,edit_post_version:1}));
  await db.run('UPDATE posts SET version=2 WHERE id=$1',[postId]);expect((await call(path(draftId))).edit_post_version).toBe(1);
  await expect(call(path(draftId),payload({version:1,edit_post_id:postId,edit_post_version:1}))).rejects.toMatchObject({status:409});
  await expect(call(path(draftId),payload({version:1,edit_post_id:postId,edit_post_version:2}))).rejects.toMatchObject({status:409});
  await expect(db.transaction(tx=>consumeDraft(tx,student,board.board.id,{draft_id:draftId,draft_version:1,edit_post_id:postId}))).rejects.toMatchObject({status:409});
  expect((await call(path(draftId))).body).toBe('실제 학생 자료 없음');
 });
 it('keeps a deleted section draft readable and requires an explicit valid replacement on save', async () => {
  const draftId=id();await call(path(draftId),payload());await db.run('UPDATE sections SET deleted_at=$2 WHERE id=$1',[board.sections[0].id,now()]);expect((await call(path(draftId))).body).toBe('실제 학생 자료 없음');await expect(call(path(draftId),payload({version:1}))).rejects.toMatchObject({status:403});
  const replacement=id();await db.run('INSERT INTO sections(id,board_id,title) VALUES($1,$2,$3)',[replacement,board.board.id,'합성 새 섹션']);expect((await call(path(draftId),payload({version:1,section_id:replacement}))).section_id).toBe(replacement);
 });
 it('consumes the correct version in a transaction and rolls consumption back on publish failure', async () => {
  const draftId=id();await call(path(draftId),payload());
  await expect(db.transaction(async tx=>{await consumeDraft(tx,student,board.board.id,{draft_id:draftId,draft_version:1});throw new Error('synthetic publish failure');})).rejects.toThrow('synthetic publish failure');
  expect((await call(path(draftId))).version).toBe(1);
  await expect(db.transaction(tx=>consumeDraft(tx,student,board.board.id,{draft_id:draftId,draft_version:2}))).rejects.toMatchObject({status:409});
  await db.transaction(tx=>consumeDraft(tx,student,board.board.id,{draft_id:draftId,draft_version:1}));expect(await call<PostDraft[]>(path())).toEqual([]);
 });
 it('rechecks revoked access and attachments inside the publishing transaction', async () => {
  const attachment=await readyFile(),draftId=id();await call(path(draftId),payload({attachment_ids:[attachment]}));
  await db.run("UPDATE attachments SET status='rejected' WHERE id=$1",[attachment]);await expect(db.transaction(tx=>consumeDraft(tx,student,board.board.id,{draft_id:draftId,draft_version:1}))).rejects.toMatchObject({code:'UPLOAD_REJECTED'});
  await db.run("UPDATE attachments SET status='ready' WHERE id=$1",[attachment]);await db.run('DELETE FROM participations WHERE principal_id=$1',[student.id]);
  await expect(db.transaction(tx=>consumeDraft(tx,student,board.board.id,{draft_id:draftId,draft_version:1}))).rejects.toMatchObject({status:404});
  expect(await db.one('SELECT id FROM post_drafts WHERE id=$1',[draftId])).not.toBeNull();
 });
});
