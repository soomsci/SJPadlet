import { createHash,randomBytes } from 'node:crypto';
import { beforeAll,beforeEach,describe,expect,it } from 'vitest';
import { getDb,id,now,type Database } from '@db';
import type { Board,BoardView,Post,Principal,ShareResult } from '@contracts';
import { createAnonymousSession } from '@server/auth';
import { getBoardView,handleBoards } from '@server/boards';
import { handleShares } from '@server/shares';
import { boardAccess } from '@server/policy';
let db:Database,teacher:Principal,student:Principal,teacherCookie:string,studentCookie:string,boardId:string,first:string,second:string,foreign:string;
function request(path:string,body?:unknown,cookie=teacherCookie,method=body===undefined?'GET':'POST'){return new Request('http://localhost:3000/api/'+path,{method,headers:{cookie,'Content-Type':'application/json'},...(body!==undefined?{body:JSON.stringify(body)}:{})});}
async function send<T=BoardView>(path:string,body?:unknown,cookie=teacherCookie,method=body===undefined?'GET':'POST'):Promise<T>{const response=await handleBoards(request(path,body,cookie,method),path.split('/'));expect(response).not.toBeNull();return (await response!.json()).data as T;}
async function shareSend<T>(path:string,body:unknown,cookie=teacherCookie):Promise<T>{const response=await handleShares(request(path,body,cookie),path.split('/'));expect(response).not.toBeNull();return (await response!.json()).data as T;}
async function version(){return (await db.one<Board>('SELECT * FROM boards WHERE id=$1',[boardId]))!.version;}
async function addPost(sectionId:string|null=first,status:Post['status']='published',rank=0){const postId=id();await db.run('INSERT INTO posts(id,board_id,section_id,author_id,title,body,status,rank,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)',[postId,boardId,sectionId,student.id,'합성 '+status,'보존할 한글 본문',status,rank,now()]);return postId;}
beforeAll(async()=>{db=await getDb();});
beforeEach(async()=>{
 await db.run('TRUNCATE principals CASCADE');await db.run('TRUNCATE rate_limits');
 teacher={id:id(),role:'teacher',display_name:'합성 교사',email:'synthetic@samjeong.ms.kr',provider_subject:id(),disabled_at:null,created_at:now()};
 await db.run('INSERT INTO principals(id,role,display_name,email,provider_subject,created_at) VALUES($1,$2,$3,$4,$5,$6)',[teacher.id,teacher.role,teacher.display_name,teacher.email,teacher.provider_subject,teacher.created_at]);
 const token=randomBytes(32).toString('base64url');teacherCookie='samjeong_session='+token;await db.run('INSERT INTO sessions(id,principal_id,token_hash,expires_at,created_at) VALUES($1,$2,$3,$4,$5)',[id(),teacher.id,createHash('sha256').update(token).digest('hex'),new Date(Date.now()+3600000).toISOString(),now()]);
 const anonymous=await createAnonymousSession('합성 학생');student=anonymous.principal;studentCookie=anonymous.cookie;
 let view=await send('boards',{title:'합성 섹션 수업',description:'실제 학생 데이터 없음',format:'columns',moderation:true});boardId=view.board.id;first=view.sections[0].id;
 view=await send('boards/'+boardId,{version:view.board.version,state:'open'},teacherCookie,'PATCH');view=await send('boards/'+boardId+'/sections',{version:view.board.version,title:'두 번째'});second=view.sections.find(section=>section.id!==first)!.id;
 const foreignBoard=await send('boards',{title:'다른 수업'});foreign=foreignBoard.sections[0].id;
 const share=await shareSend<ShareResult>('shares',{board_id:boardId,target_type:'board',target_id:boardId,scope:'write'});await shareSend('join',{token:share.url.split('/').at(-1),mode:'anonymous'},studentCookie);
});
describe('teacher section insertion and optimistic updates',()=>{
 it('inserts before and after a referenced section and retains existing section identities',async()=>{
  let view=await send('boards/'+boardId+'/sections',{version:await version(),title:'앞에 삽입',before_id:second});const insertedBefore=view.sections.find(section=>section.title==='앞에 삽입')!.id;expect(view.sections.map(section=>section.id)).toEqual([first,insertedBefore,second]);
  view=await send('boards/'+boardId+'/sections',{version:view.board.version,title:'뒤에 삽입',after_id:first});const insertedAfter=view.sections.find(section=>section.title==='뒤에 삽입')!.id;expect(view.sections.map(section=>section.id)).toEqual([first,insertedAfter,insertedBefore,second]);
 });
 it.each(['before_id','after_id'])('rejects a foreign section as %s without a partial insert',async position=>{
  const before=await version();await expect(send('boards/'+boardId+'/sections',{version:before,title:'범위 밖', [position]:foreign})).rejects.toMatchObject({status:400,code:'INVALID_INPUT'});expect(await version()).toBe(before);expect((await getBoardView(teacher,boardId)).sections).toHaveLength(2);
 });
 it('rejects competing insertion positions, student creation/rename, and stale mutation versions',async()=>{
  const expected=await version();await expect(send('boards/'+boardId+'/sections',{version:expected,title:'중복 위치',before_id:first,after_id:second})).rejects.toMatchObject({status:400});
  await expect(send('boards/'+boardId+'/sections',{version:expected,title:'학생 생성'},studentCookie)).rejects.toMatchObject({status:403});await expect(send('boards/'+boardId+'/sections/'+first,{version:expected,title:'학생 변경'},studentCookie,'PATCH')).rejects.toMatchObject({status:403});
  const view=await send('boards/'+boardId+'/sections/'+first,{version:expected,title:'수정한 섹션'},teacherCookie,'PATCH');expect(view.sections[0].title).toBe('수정한 섹션');await expect(send('boards/'+boardId+'/sections',{version:expected,title:'이전 버전'})).rejects.toMatchObject({status:409,code:'CONFLICT'});expect(await version()).toBe(view.board.version);
 });
});
describe('section deletion, ownership and invitation revocation',()=>{
 it('moves every post and draft while preserving statuses, revokes old invitations and keeps them revoked after restore',async()=>{
  const statuses:Post['status'][]=['published','pending','rejected','hidden','deleted'];for(const status of statuses)await addPost(first,status);
  const draftId=id();await db.run('INSERT INTO post_drafts(id,board_id,principal_id,section_id,title,body,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$7)',[draftId,boardId,student.id,first,'합성 초안','저장된 본문',now()]);
  const restricted=await createAnonymousSession('섹션 전용 합성 학생');const invite=await shareSend<ShareResult>('shares',{board_id:boardId,target_type:'section',target_id:first,scope:'write'});const token=invite.url.split('/').at(-1);await shareSend('join',{token,mode:'anonymous'},restricted.cookie);expect((await boardAccess(db,restricted.principal,boardId)).can_write).toBe(true);
  let view=await send('boards/'+boardId+'/sections/'+first,{version:await version(),move_to:second},teacherCookie,'DELETE');expect(view.sections.map(section=>section.id)).toEqual([second]);expect(view.deleted_sections?.map(section=>section.id)).toEqual([first]);
  const posts=await db.all<Post>('SELECT * FROM posts WHERE board_id=$1',[boardId]);expect(posts).toHaveLength(statuses.length);expect(posts.map(post=>post.status).sort()).toEqual([...statuses].sort());for(const post of posts){expect(post.section_id).toBe(second);expect(post.author_id).toBe(student.id);expect(post.body).toBe('보존할 한글 본문');expect(post.version).toBe(2);}
  expect(await db.one('SELECT principal_id,section_id,body,version FROM post_drafts WHERE id=$1',[draftId])).toMatchObject({principal_id:student.id,section_id:second,body:'저장된 본문',version:2});
  await expect(boardAccess(db,restricted.principal,boardId)).rejects.toMatchObject({code:'NOT_FOUND'});await expect(shareSend('join',{token,mode:'anonymous'},restricted.cookie)).rejects.toMatchObject({code:'SHARE_EXPIRED'});
  const studentView=await send('boards/'+boardId,undefined,studentCookie);expect(studentView).not.toHaveProperty('deleted_sections');expect(studentView.sections.map(section=>section.id)).toEqual([second]);
  view=await send('boards/'+boardId+'/sections/'+first+'/restore',{version:view.board.version});expect(view.sections.map(section=>section.id)).toEqual([second,first]);expect(view.deleted_sections).toHaveLength(0);
  expect((await db.all<Post>('SELECT * FROM posts WHERE board_id=$1',[boardId])).every(post=>post.section_id===second)).toBe(true);expect(await db.one('SELECT section_id FROM post_drafts WHERE id=$1',[draftId])).toMatchObject({section_id:second});
  await expect(shareSend('join',{token,mode:'anonymous'},restricted.cookie)).rejects.toMatchObject({code:'SHARE_EXPIRED'});await expect(boardAccess(db,restricted.principal,boardId)).rejects.toMatchObject({code:'NOT_FOUND'});
 });
 it('supports moving into unclassified and rejects writes into a deleted section',async()=>{
  const postId=await addPost();const view=await send('boards/'+boardId+'/sections/'+first,{version:await version(),move_to:null},teacherCookie,'DELETE');expect(await db.one('SELECT section_id,status FROM posts WHERE id=$1',[postId])).toMatchObject({section_id:null,status:'published'});
  await expect(send('boards/'+boardId+'/posts',{title:'삭제된 섹션',section_id:first},studentCookie)).rejects.toMatchObject({status:400});await expect(send('boards/'+boardId+'/sections/'+first,{version:view.board.version,title:'삭제된 이름'},teacherCookie,'PATCH')).rejects.toMatchObject({status:404});
 });
 it('rejects a foreign/self destination, foreign delete/restore, and stale versions without moving records',async()=>{
  const postId=await addPost();const current=await version();for(const move_to of [first,foreign])await expect(send('boards/'+boardId+'/sections/'+first,{version:current,move_to},teacherCookie,'DELETE')).rejects.toMatchObject({status:400});
  await expect(send('boards/'+boardId+'/sections/'+foreign,{version:current,move_to:second},teacherCookie,'DELETE')).rejects.toMatchObject({status:404});await expect(send('boards/'+boardId+'/sections/'+foreign+'/restore',{version:current})).rejects.toMatchObject({status:404});await expect(send('boards/'+boardId+'/sections/'+first,{version:current+1,move_to:second},teacherCookie,'DELETE')).rejects.toMatchObject({status:409});
  expect(await db.one('SELECT section_id,version FROM posts WHERE id=$1',[postId])).toMatchObject({section_id:first,version:1});expect(await version()).toBe(current);
 });
 it('requires teacher management for both deletion and restoration and rejects stale restore versions',async()=>{
  const current=await version();await expect(send('boards/'+boardId+'/sections/'+first,{version:current,move_to:second},studentCookie,'DELETE')).rejects.toMatchObject({status:403});const deleted=await send('boards/'+boardId+'/sections/'+first,{version:current,move_to:second},teacherCookie,'DELETE');
  await expect(send('boards/'+boardId+'/sections/'+first+'/restore',{version:deleted.board.version},studentCookie)).rejects.toMatchObject({status:403});await expect(send('boards/'+boardId+'/sections/'+first+'/restore',{version:current})).rejects.toMatchObject({status:409});
 });
});
describe('complete-list teacher ordering',()=>{
 it('reorders sections through a complete list and refuses stale or student requests',async()=>{
  const current=await version();const view=await send('boards/'+boardId+'/sections/reorder',{version:current,section_ids:[second,first]});expect(view.sections.map(section=>section.id)).toEqual([second,first]);await expect(send('boards/'+boardId+'/sections/reorder',{version:current,section_ids:[first,second]})).rejects.toMatchObject({status:409});await expect(send('boards/'+boardId+'/sections/reorder',{version:view.board.version,section_ids:[first,second]},studentCookie)).rejects.toMatchObject({status:403});
 });
 it.each(['duplicate','foreign','missing'])('rejects %s section IDs and preserves the original order',async kind=>{
  const ids=kind==='duplicate'?[first,first]:kind==='foreign'?[first,foreign]:[first];const current=await version();await expect(send('boards/'+boardId+'/sections/reorder',{version:current,section_ids:ids})).rejects.toMatchObject({status:400});expect((await getBoardView(teacher,boardId)).sections.map(section=>section.id)).toEqual([first,second]);expect(await version()).toBe(current);
 });
 it('reorders only the complete post set in one section, including pending/hidden while excluding deleted',async()=>{
  const a=await addPost(first,'published',0),b=await addPost(first,'pending',100),hidden=await addPost(first,'hidden',200),deleted=await addPost(first,'deleted',300),outside=await addPost(second,'published',0);const current=await version();
  const view=await send('boards/'+boardId+'/posts/reorder',{version:current,section_id:first,post_ids:[hidden,b,a]});const rows=await db.all<Post>("SELECT * FROM posts WHERE board_id=$1 AND section_id=$2 AND status<>'deleted' ORDER BY rank",[boardId,first]);expect(rows.map(post=>post.id)).toEqual([hidden,b,a]);expect(rows.map(post=>post.status)).toEqual(['hidden','pending','published']);expect(rows.every(post=>post.body==='보존할 한글 본문'&&post.author_id===student.id&&post.version===2)).toBe(true);expect(await db.one('SELECT rank,version FROM posts WHERE id=$1',[deleted])).toMatchObject({rank:300,version:1});expect(await db.one('SELECT rank,version FROM posts WHERE id=$1',[outside])).toMatchObject({rank:0,version:1});
  await expect(send('boards/'+boardId+'/posts/reorder',{version:current,section_id:first,post_ids:[a,b,hidden]})).rejects.toMatchObject({status:409});await expect(send('boards/'+boardId+'/posts/reorder',{version:view.board.version,section_id:first,post_ids:[a,b,hidden]},studentCookie)).rejects.toMatchObject({status:403});
 });
 it.each(['duplicate','foreign','missing','wrong-section'])('rejects %s post ordering without partial rank/version changes',async kind=>{
  const a=await addPost(first,'published',500),b=await addPost(first,'pending',800),outside=await addPost(second,'published',900);const current=await version();const ids=kind==='duplicate'?[a,a]:kind==='foreign'?[a,'nonexistent-post']:kind==='missing'?[a]:[a,outside];await expect(send('boards/'+boardId+'/posts/reorder',{version:current,section_id:first,post_ids:ids})).rejects.toMatchObject({status:400});expect(await db.one('SELECT rank,version FROM posts WHERE id=$1',[a])).toMatchObject({rank:500,version:1});expect(await db.one('SELECT rank,version FROM posts WHERE id=$1',[b])).toMatchObject({rank:800,version:1});expect(await version()).toBe(current);
 });
 it('supports the complete unclassified post set and rejects a foreign section',async()=>{
  const a=await addPost(null,'published',0),b=await addPost(null,'published',100);const view=await send('boards/'+boardId+'/posts/reorder',{version:await version(),section_id:null,post_ids:[b,a]});expect(view.posts.map(post=>post.id)).toEqual([b,a]);await expect(send('boards/'+boardId+'/posts/reorder',{version:view.board.version,section_id:foreign,post_ids:[]})).rejects.toMatchObject({status:400});
 });
});
describe('persisted board appearance',()=>{
 it('preserves content on appearance/layout changes and copies appearance into a private duplicate',async()=>{
  const postId=await addPost();await db.run('UPDATE posts SET link=$2,color=$3 WHERE id=$1',[postId,'https://example.invalid/synthetic-class','#ffeeaa']);const appearance={column_width:440,font_scale:'large',card_density:'compact',background_style:'paper',color:'#ddeeff'};
  const view=await send('boards/'+boardId,{version:await version(),format:'grid',...appearance},teacherCookie,'PATCH');expect(view.board).toMatchObject({...appearance,format:'grid'});expect(view.posts[0]).toMatchObject({id:postId,body:'보존할 한글 본문',section_id:first,link:'https://example.invalid/synthetic-class',color:'#ffeeaa'});
  const duplicate=await send('boards/'+boardId+'/duplicate',{include_posts:true});expect(duplicate.board).toMatchObject({...appearance,format:'grid',state:'draft'});expect(duplicate.posts).toHaveLength(1);expect(duplicate.posts[0]).toMatchObject({title:view.posts[0].title,body:view.posts[0].body,link:view.posts[0].link,color:view.posts[0].color,is_mine:true});expect(duplicate.posts[0].id).not.toBe(postId);expect(duplicate.sections.find(section=>section.id===duplicate.posts[0].section_id)?.title).toBe(view.sections[0].title);await expect(getBoardView(student,duplicate.board.id)).rejects.toMatchObject({status:404});
 });
 it.each([{column_width:259},{column_width:441},{column_width:300.5},{font_scale:'huge'},{card_density:'dense'},{background_style:'image'},{color:'red'}])('rejects invalid appearance %j atomically',async invalid=>{
  const current=await version();await expect(send('boards/'+boardId,{version:current,title:'실패 시 보존',...invalid},teacherCookie,'PATCH')).rejects.toMatchObject({status:400,code:'INVALID_INPUT'});expect((await getBoardView(teacher,boardId)).board.title).toBe('합성 섹션 수업');expect(await version()).toBe(current);
 });
 it('rejects student appearance changes and stale versions',async()=>{
  const current=await version();await expect(send('boards/'+boardId,{version:current,column_width:260},studentCookie,'PATCH')).rejects.toMatchObject({status:403});const view=await send('boards/'+boardId,{version:current,column_width:260,font_scale:'small',card_density:'comfortable',background_style:'solid'},teacherCookie,'PATCH');expect(view.board.column_width).toBe(260);await expect(send('boards/'+boardId,{version:current,font_scale:'large'},teacherCookie,'PATCH')).rejects.toMatchObject({status:409});
 });
});
