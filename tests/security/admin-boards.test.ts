import { createHash, randomBytes } from 'node:crypto';
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { getDb, id, now, type Database } from '@db';
import type { AdminBoardList, Board, BoardView, Principal } from '@contracts';
import { dispatch } from '@server/dispatch';
import { boardAccess, canManage } from '@server/policy';

vi.mock('@server/media/storage',()=>({getObject:vi.fn(async()=>({body:new Uint8Array([1,2])})),putObject:vi.fn(),deleteObject:vi.fn()}));
let db:Database;
let admin:Principal,teacher:Principal,other:Principal,student:Principal,anonymous:Principal;
let adminCookie:string,teacherCookie:string,otherCookie:string,studentCookie:string,anonymousCookie:string;
async function account(role:Principal['role'],name:string):Promise<[Principal,string]>{
  const principal:Principal={id:id(),role,display_name:name,email:role==='anonymous'?null:`${id()}@samjeong.ms.kr`,provider_subject:id(),disabled_at:null,created_at:now()};
  await db.run('INSERT INTO principals(id,role,display_name,email,provider_subject,created_at) VALUES($1,$2,$3,$4,$5,$6)',[principal.id,role,name,principal.email,principal.provider_subject,principal.created_at]);
  const token=randomBytes(32).toString('base64url');
  await db.run('INSERT INTO sessions(id,principal_id,token_hash,expires_at,created_at) VALUES($1,$2,$3,$4,$5)',[id(),principal.id,createHash('sha256').update(token).digest('hex'),new Date(Date.now()+3600000).toISOString(),now()]);
  return [principal,'samjeong_session='+token];
}
async function board(state:Board['state']='open',owner=teacher.id,title='합성 과학 수업',trash=false){
  const boardId=id();
  await db.run('INSERT INTO boards(id,owner_id,title,description,format,state,participation_mode,deleted_at,created_at,updated_at) VALUES($1,$2,$3,$4,\'wall\',$5,\'both\',$6,$7,$7)',[boardId,owner,title,'목록에 보내지 않는 본문',state,trash?now():null,now()]);
  return boardId;
}
function request(path:string,cookie=adminCookie,method='GET',body?:unknown,origin='http://localhost:3000'){
  return dispatch(new Request('http://localhost:3000/api/'+path,{method,headers:{cookie,origin,'Content-Type':'application/json'},...(body!==undefined?{body:JSON.stringify(body)}:{})}),path.split('?')[0].split('/'));
}
async function data<T>(response:Response){expect(response.status).toBeLessThan(300);return (await response.json()).data as T;}
async function current(boardId:string){return (await db.one<Board>('SELECT * FROM boards WHERE id=$1',[boardId]))!;}
beforeAll(async()=>{db=await getDb();});
beforeEach(async()=>{
  vi.stubEnv('APP_URL','http://localhost:3000');await db.run('TRUNCATE principals CASCADE');
  [admin,adminCookie]=await account('admin','합성 관리자');[teacher,teacherCookie]=await account('teacher','합성 과학 교사');[other,otherCookie]=await account('teacher','합성 수학 교사');[student,studentCookie]=await account('student','합성 학생');[anonymous,anonymousCookie]=await account('anonymous','합성 별명');
});
afterEach(()=>vi.unstubAllEnvs());

describe('school-wide board administration',()=>{
  it('lists all owners and states with counts, search, owner/status filters and separate trash',async()=>{
    const open=await board(),draft=await board('draft',other.id,'비공개 준비'),archived=await board('archived'),trash=await board('open',other.id,'삭제된 수업',true);
    await db.run("INSERT INTO posts(id,board_id,author_id,title,body,status,created_at,updated_at) VALUES($1,$2,$3,'비밀 답안','목록 비공개 답안','pending',$4,$4)",[id(),open,student.id,now()]);
    const list=await data<AdminBoardList>(await request('admin/boards'));
    expect(new Set(list.boards.map(b=>b.id))).toEqual(new Set([open,draft,archived]));
    expect(list.boards.find(b=>b.id===open)).toMatchObject({owner_name:teacher.display_name,post_count:1,pending_count:1,version:1});
    expect(JSON.stringify(list)).not.toMatch(/목록 비공개 답안|비밀 답안|목록에 보내지 않는 본문/);
    for(const [query,expected] of [['state=trash',trash],['state=draft',draft],['owner='+other.id,draft],['q='+encodeURIComponent('수학 교사'),draft],['q='+encodeURIComponent(other.email!),draft]]){
      expect((await data<AdminBoardList>(await request('admin/boards?'+query))).boards.map(b=>b.id)).toEqual([expected]);
    }
    expect((await request('admin/boards?state=invalid')).status).toBe(400);
  });
  it('treats wildcard searches literally and paginates tied timestamps without duplicate or missing rows',async()=>{
    const special=await board('draft',teacher.id,'100%_확인');await board('draft',teacher.id,'100일 확인');
    expect((await data<AdminBoardList>(await request('admin/boards?q='+encodeURIComponent('%_')))).boards.map(b=>b.id)).toEqual([special]);
    for(let i=0;i<53;i++)await board('open',teacher.id,'페이지 '+i);
    await db.run('UPDATE boards SET updated_at=$1',['2026-10-15T00:00:00.000Z']);
    const first=await data<AdminBoardList>(await request('admin/boards'));
    expect(first.boards).toHaveLength(50);expect(first.next_cursor).toBeTruthy();
    const second=await data<AdminBoardList>(await request('admin/boards?cursor='+encodeURIComponent(first.next_cursor!)));
    expect(second.boards).toHaveLength(5);expect(second.next_cursor).toBeNull();expect(new Set([...first.boards,...second.boards].map(b=>b.id)).size).toBe(55);
  });
  it('rejects non-admin list/transfer requests and unauthenticated, suspended and cross-origin access',async()=>{
    const b=await board();
    for(const cookie of [teacherCookie,otherCookie,studentCookie,anonymousCookie]){
      expect((await request('admin/boards',cookie)).status).toBe(403);
      expect((await request('admin/transfer',cookie,'POST',{board_id:b,owner_id:other.id,version:1})).status).toBe(403);
    }
    expect((await request('admin/boards','')).status).toBe(401);
    expect((await request('admin/transfer',adminCookie,'POST',{board_id:b,owner_id:other.id,version:1},'https://outside.invalid')).status).toBe(403);
    await db.run('UPDATE principals SET disabled_at=$2 WHERE id=$1',[admin.id,now()]);
    expect((await request('admin/boards')).status).toBe(401);
    await expect(boardAccess(db,admin,b)).rejects.toMatchObject({status:403});
  });
  it('reads any board state, records foreign access once per ten minutes, and refreshes role changes',async()=>{
    for(const state of ['draft','open','closed','archived'] as const){
      const b=await board(state);expect((await data<BoardView>(await request('boards/'+b))).can_manage).toBe(true);
      await boardAccess(db,admin,b);expect(await canManage(db,admin,await current(b))).toBe(true);
      expect(await db.all("SELECT 1 FROM audit_events WHERE actor_id=$1 AND board_id=$2 AND action='admin.board.access'",[admin.id,b])).toHaveLength(1);
      for(const cookie of [otherCookie,studentCookie,anonymousCookie])expect((await request('boards/'+b,cookie)).status).toBe(404);
    }
    const b=await board();await db.run("UPDATE principals SET role='teacher' WHERE id=$1",[admin.id]);
    expect(await canManage(db,admin,await current(b))).toBe(false);await expect(boardAccess(db,admin,b)).rejects.toMatchObject({status:404});
    expect(await canManage(db,{...student,role:'admin'},await current(b))).toBe(false);
  });
  it('uses the same management policy for pending posts, files, exports, moderation and QR sharing',async()=>{
    const b=await board(),postId=id(),file=id();
    await db.run("INSERT INTO posts(id,board_id,author_id,title,body,status,created_at,updated_at) VALUES($1,$2,$3,'대기 답안','비공개','pending',$4,$4)",[postId,b,student.id,now()]);
    await db.run("INSERT INTO attachments(id,board_id,post_id,uploader_id,name,mime,bytes,storage_key,status,created_at) VALUES($1,$2,$3,$4,'합성.png','image/png',2,$5,'ready',$6)",[file,b,postId,student.id,id(),now()]);
    expect((await data<BoardView>(await request('boards/'+b))).posts[0].status).toBe('pending');
    expect((await request('attachments/'+file+'/content')).status).toBe(200);
    const exported=await request('boards/'+b+'/export');expect(exported.status).toBe(200);expect(await exported.text()).toContain('대기 답안');
    expect((await request('shares',adminCookie,'POST',{board_id:b,target_type:'board',target_id:b,scope:'write',expires_hours:24})).status).toBe(201);
    expect((await request('posts/'+postId+'/moderation',adminCookie,'POST',{version:1,status:'published'})).status).toBe(200);
    for(const cookie of [otherCookie,studentCookie,anonymousCookie]){
      expect((await request('attachments/'+file+'/content',cookie)).status).toBe(404);
      expect((await request('boards/'+b+'/export',cookie)).status).toBe(404);
    }
    expect(await db.one("SELECT 1 FROM audit_events WHERE action='post.published' AND actor_id=$1 AND board_id=$2",[admin.id,b])).toBeTruthy();
  });
  it('closes, archives, reopens, trashes and restores a foreign board with version checks and notifications',async()=>{
    const b=await board();
    for(const [version,state] of [[1,'closed'],[2,'archived'],[3,'open']] as const){expect((await request('boards/'+b,adminCookie,'PATCH',{version,state})).status).toBe(200);}
    expect((await request('boards/'+b,adminCookie,'DELETE',{version:1})).status).toBe(409);
    expect((await request('boards/'+b,otherCookie,'DELETE',{version:4})).status).toBe(404);
    expect((await request('boards/'+b,adminCookie,'DELETE',{version:4})).status).toBe(200);
    expect((await request('boards/'+b)).status).toBe(404);
    expect((await request('boards/'+b+'/restore',otherCookie,'POST',{version:5})).status).toBe(403);
    expect((await request('boards/'+b+'/restore',adminCookie,'POST',{version:4})).status).toBe(409);
    expect((await data<BoardView>(await request('boards/'+b+'/restore',adminCookie,'POST',{version:5}))).board).toMatchObject({state:'closed',deleted_at:null,owner_id:teacher.id,version:6});
    expect((await db.all<{action:string}>('SELECT action FROM audit_events WHERE board_id=$1 AND actor_id=$2',[b,admin.id])).map(e=>e.action)).toEqual(expect.arrayContaining(['board.closed','board.archived','board.open','board.delete','board.restore']));
    expect((await db.all<{event_type:string}>('SELECT event_type FROM outbox_events WHERE board_id=$1',[b])).map(e=>e.event_type)).toEqual(expect.arrayContaining(['settings','deleted','restored']));
  });
  it('transfers only to another active teacher, prevents stale writes and updates ownership/memberships atomically',async()=>{
    const b=await board();await db.run("INSERT INTO board_members(board_id,principal_id,role) VALUES($1,$2,'editor')",[b,other.id]);
    for(const owner of [teacher.id,student.id,anonymous.id,'missing'])expect((await request('admin/transfer',adminCookie,'POST',{board_id:b,owner_id:owner,version:1})).status).toBe(400);
    await db.run('UPDATE principals SET disabled_at=$2 WHERE id=$1',[other.id,now()]);
    expect((await request('admin/transfer',adminCookie,'POST',{board_id:b,owner_id:other.id,version:1})).status).toBe(400);
    await db.run('UPDATE principals SET disabled_at=NULL WHERE id=$1',[other.id]);
    expect((await request('admin/transfer',adminCookie,'POST',{board_id:b,owner_id:other.id,version:2})).status).toBe(409);
    expect((await request('admin/transfer',adminCookie,'POST',{board_id:b,owner_id:other.id,version:1})).status).toBe(200);
    expect(await current(b)).toMatchObject({owner_id:other.id,version:2});
    expect(await db.one('SELECT 1 FROM board_members WHERE board_id=$1 AND principal_id=$2',[b,other.id])).toBeNull();
    expect((await request('boards/'+b,teacherCookie)).status).toBe(404);
    expect((await data<BoardView>(await request('boards/'+b,otherCookie))).can_manage).toBe(true);
    expect(await db.one("SELECT 1 FROM audit_events WHERE action='board.transfer' AND board_id=$1 AND actor_id=$2",[b,admin.id])).toBeTruthy();
    expect(await db.one("SELECT 1 FROM outbox_events WHERE event_type='permissions' AND board_id=$1",[b])).toBeTruthy();
  });
  it('lets admins manage co-teachers while keeping editor ownership restrictions',async()=>{
    const b=await board();
    expect((await request('boards/'+b+'/members',adminCookie,'POST',{email:other.email,role:'editor'})).status).toBe(200);
    expect((await data<{can_edit_members:boolean}>(await request('boards/'+b+'/members'))).can_edit_members).toBe(true);
    expect((await request('boards/'+b+'/members',otherCookie,'POST',{email:admin.email,role:'reader'})).status).toBe(403);
    expect((await request('boards/'+b,otherCookie,'DELETE',{version:1})).status).toBe(403);
    expect((await request('boards/'+b+'/members',adminCookie,'DELETE',{principal_id:other.id})).status).toBe(200);
    expect((await request('boards/'+b,otherCookie)).status).toBe(404);
  });
});
