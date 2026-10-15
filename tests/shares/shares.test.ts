import { createHash, randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Board, Principal, ShareResult } from '@contracts';
import { getDb, id, now } from '@db';
import { handleShares } from '@server/shares';
import { getPrincipal } from '@server/auth';
import { boardAccess } from '@server/policy';

const digest=(v:string)=>createHash('sha256').update(v).digest('hex');
let teacher:Principal;let teacherCookie:string;let board:Board;
const request=(path:string,body?:unknown,cookie?:string)=>new Request('http://localhost:3000/api/'+path,{method:body?'POST':'GET',headers:{...(cookie?{Cookie:cookie}:{}),'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
async function send<T>(path:string,body?:unknown,cookie=teacherCookie):Promise<T>{const response=await handleShares(request(path,body,cookie),path.split('?')[0].split('/'));if(!response)throw new Error('Missing response');return (await response.json()).data as T;}
async function create(overrides:Record<string,unknown>={}){return send<ShareResult>('shares',{board_id:board.id,target_type:'board',target_id:board.id,scope:'write',expires_hours:24,...overrides});}
async function makePrincipal(role:Principal['role']){const db=await getDb(),pid=id(),token=randomBytes(32).toString('base64url');await db.run('INSERT INTO principals(id,role,display_name,created_at) VALUES($1,$2,$3,$4)',[pid,role,'합성 테스트',now()]);await db.run('INSERT INTO sessions(id,principal_id,token_hash,expires_at,created_at) VALUES($1,$2,$3,$4,$5)',[id(),pid,digest(token),new Date(Date.now()+86400000).toISOString(),now()]);return {principal:(await db.one<Principal>('SELECT * FROM principals WHERE id=$1',[pid]))!,cookie:'samjeong_session='+token};}
beforeAll(async()=>{
 const account=await makePrincipal('teacher');teacher=account.principal;teacherCookie=account.cookie;const db=await getDb();const bid=id();
 await db.run("INSERT INTO boards(id,owner_id,title,description,format,state,participation_mode,created_at,updated_at) VALUES($1,$2,'비공개 합성 수업','개인 수업 안내','wall','open','both',$3,$3)",[bid,teacher.id,now()]);board=(await db.one<Board>('SELECT * FROM boards WHERE id=$1',[bid]))!;
});
describe('sharing and student participation',()=>{
 it('stores hashes only, returns fresh secrets once, and hides metadata in preview',async()=>{
  const share=await create();const token=share.url.split('/').at(-1)!;expect(Buffer.from(token,'base64url').length).toBeGreaterThanOrEqual(16);
  const db=await getDb();const saved=await db.one<{token_hash:string;code_hash:string}>('SELECT token_hash,code_hash FROM share_links WHERE id=$1',[share.id]);expect(saved).toEqual({token_hash:digest(token),code_hash:digest(share.code)});
  const preview=await send('share-preview?token='+token);expect(preview).toEqual({participation_mode:'both'});
  const list=await send<Record<string,unknown>[]>('boards/'+board.id+'/shares');expect(list.find(s=>s.id===share.id)).not.toHaveProperty('token_hash');expect(JSON.stringify(list)).not.toContain(token);expect(JSON.stringify(list)).not.toContain(share.code);
 });
 it('anonymous token entry creates an HttpOnly server session and grants access',async()=>{
  const share=await create();const response=await handleShares(request('join',{token:share.url.split('/').at(-1),mode:'anonymous',display_name:'별명'}),['join']);expect(response).not.toBeNull();
  const cookie=response!.headers.get('Set-Cookie')!;expect(cookie).toContain('HttpOnly');const principal=await getPrincipal(request('me',undefined,cookie));expect(principal?.role).toBe('anonymous');expect(principal?.display_name).toBe('별명');
  const access=await boardAccess(await getDb(),principal!,board.id);expect(access.can_write).toBe(true);
 });
 it('accepts normalized short codes, retains target destination, and enforces read-only',async()=>{
  const sectionId=id();await (await getDb()).run("INSERT INTO sections(id,board_id,title,rank) VALUES($1,$2,'섹션',0)",[sectionId,board.id]);
  const share=await create({target_type:'section',target_id:sectionId,scope:'read'});const student=await makePrincipal('student');
  const result=await send<{destination:string}>('join',{code:share.code.toLowerCase().slice(0,5)+'-'+share.code.slice(5),mode:'login'},student.cookie);expect(result.destination).toBe('/boards/'+board.id+'?section='+sectionId);
  const access=await boardAccess(await getDb(),student.principal,board.id);expect(access.can_write).toBe(false);
 });
 it('validates ownership of a target and protects share management',async()=>{
  await expect(create({target_type:'section',target_id:id()})).rejects.toMatchObject({code:'NOT_FOUND'});
  await expect(create({target_type:'submission',target_id:id()})).rejects.toMatchObject({code:'INVALID_INPUT'});
  const outsider=await makePrincipal('teacher');await expect(send('boards/'+board.id+'/shares',undefined,outsider.cookie)).rejects.toMatchObject({code:'NOT_FOUND'});
  const share=await create();await expect(send('shares/'+share.id+'/revoke',{},outsider.cookie)).rejects.toMatchObject({code:'NOT_FOUND'});
 });
 it('denies unauthenticated login participation and login-required anonymous participation',async()=>{
  const share=await create();const token=share.url.split('/').at(-1);await expect(send('join',{token,mode:'login'},'')).rejects.toMatchObject({code:'AUTH_REQUIRED'});
  await (await getDb()).run("UPDATE boards SET participation_mode='login' WHERE id=$1",[board.id]);
  await expect(send('join',{token,mode:'anonymous'},'')).rejects.toMatchObject({code:'LOGIN_REQUIRED'});
  await (await getDb()).run("UPDATE boards SET participation_mode='both' WHERE id=$1",[board.id]);
 });
 it('revocation invalidates the old QR, code, and an existing grant',async()=>{
  const share=await create();const student=await makePrincipal('student');const token=share.url.split('/').at(-1);await send('join',{token,mode:'login'},student.cookie);
  await send('shares/'+share.id+'/revoke',{});await expect(send('join',{code:share.code,mode:'login'},student.cookie)).rejects.toMatchObject({code:'SHARE_EXPIRED'});await expect(send('share-preview?token='+token)).rejects.toMatchObject({code:'SHARE_EXPIRED'});await expect(boardAccess(await getDb(),student.principal,board.id)).rejects.toMatchObject({code:'NOT_FOUND'});
 });
 it('expired invitations and blocked participants cannot rejoin',async()=>{
  const share=await create();const student=await makePrincipal('student');await send('join',{code:share.code,mode:'login'},student.cookie);const db=await getDb();await db.run('UPDATE participations SET blocked_at=$1 WHERE principal_id=$2 AND share_id=$3',[now(),student.principal.id,share.id]);await expect(send('join',{code:share.code,mode:'login'},student.cookie)).rejects.toMatchObject({code:'FORBIDDEN'});
  await db.run('UPDATE share_links SET expires_at=$1 WHERE id=$2',[new Date(0).toISOString(),share.id]);await expect(send('join',{code:share.code,mode:'login'},student.cookie)).rejects.toMatchObject({code:'SHARE_EXPIRED'});
 });
 it('submission links preserve the private submission destination',async()=>{
  const share=await create({target_type:'submission'});const student=await makePrincipal('student');const result=await send<{destination:string}>('join',{code:share.code,mode:'login'},student.cookie);expect(result.destination).toBe('/boards/'+board.id+'?submission=1');expect((await boardAccess(await getDb(),student.principal,board.id)).submission_only).toBe(true);
 });
 it('a board-level block prevents joining through a newly issued invitation',async()=>{
  const student=await makePrincipal('student');const db=await getDb();await db.run('INSERT INTO board_blocks(board_id,principal_id,created_at) VALUES($1,$2,$3)',[board.id,student.principal.id,now()]);
  const share=await create();await expect(send('join',{code:share.code,mode:'login'},student.cookie)).rejects.toMatchObject({code:'FORBIDDEN'});
 });
 it('revoking one invitation preserves the scope of another valid invitation',async()=>{
  const writeShare=await create();const readShare=await create({scope:'read'});const student=await makePrincipal('student');await send('join',{code:writeShare.code,mode:'login'},student.cookie);await send('join',{code:readShare.code,mode:'login'},student.cookie);
  expect((await boardAccess(await getDb(),student.principal,board.id)).can_write).toBe(true);await send('shares/'+writeShare.id+'/revoke',{});const access=await boardAccess(await getDb(),student.principal,board.id);expect(access.can_write).toBe(false);expect(access.shares.map(s=>s.id)).toEqual([readShare.id]);
 });
 it('invalidates access to deleted targets, checks expiry bounds and rate limits DB-wide',async()=>{
  await expect(create({expires_hours:721})).rejects.toMatchObject({code:'INVALID_INPUT'});
  const sectionId=id(),db=await getDb();await db.run("INSERT INTO sections(id,board_id,title) VALUES($1,$2,'삭제될 섹션')",[sectionId,board.id]);const share=await create({target_type:'section',target_id:sectionId});await db.run('DELETE FROM sections WHERE id=$1',[sectionId]);await expect(send('join',{code:share.code,mode:'anonymous'},'')).rejects.toMatchObject({code:'NOT_FOUND'});
  await db.run("INSERT INTO rate_limits(key,count,resets_at) VALUES('share.code.global',1200,$1) ON CONFLICT(key) DO UPDATE SET count=1200,resets_at=EXCLUDED.resets_at",[new Date(Date.now()+60000).toISOString()]);await expect(send('join',{code:'AABBCCDDEE',mode:'anonymous'},'')).rejects.toMatchObject({code:'RATE_LIMITED'});
  const spoofed=request('join',{code:'AABBCCDDEE',mode:'anonymous'});spoofed.headers.set('X-Forwarded-For','192.0.2.44');await expect(handleShares(spoofed,['join'])).rejects.toMatchObject({code:'RATE_LIMITED'});
  await db.run("DELETE FROM rate_limits WHERE key='share.code.global'");
 });
});
describe('shared classroom devices and per-client limits',()=>{
 it('prints the short SHARE_URL host in links while keeping the same /s/ path',async()=>{
  vi.stubEnv('SHARE_URL','https://sjmoa.pages.dev');try{const share=await create();expect(share.url).toMatch(/^https:\/\/sjmoa\.pages\.dev\/s\/[A-Za-z0-9_-]{43}$/);}finally{vi.unstubAllEnvs();}
 });
 const cookieOf=(response:Response|null)=>response!.headers.get('Set-Cookie')!.split(';')[0];
 const join=(body:Record<string,unknown>,cookie?:string,ip?:string)=>{const req=request('join',body,cookie);if(ip)req.headers.set('cf-connecting-ip',ip);return handleShares(req,['join']);};
 it('starts a new anonymous identity by default on a device and ends the previous student session',async()=>{
  const token=(await create()).url.split('/').at(-1);
  const first=await join({token,mode:'anonymous',display_name:'학생 가'});const a=cookieOf(first);
  expect(first!.headers.get('Set-Cookie')).toContain('Max-Age=86400');
  const b=cookieOf(await join({token,mode:'anonymous',display_name:'학생 나'},a));
  expect(await getPrincipal(request('me',undefined,a))).toBeNull();
  expect((await getPrincipal(request('me',undefined,b)))?.display_name).toBe('학생 나');
 });
 it('ends a signed-in session on the device when that user joins anonymously instead',async()=>{
  const token=(await create()).url.split('/').at(-1);const google=await makePrincipal('student');
  const anonymous=cookieOf(await join({token,mode:'anonymous'},google.cookie));
  expect(await getPrincipal(request('me',undefined,google.cookie))).toBeNull();
  expect((await getPrincipal(request('me',undefined,anonymous)))?.role).toBe('anonymous');
 });
 it('keeps the same anonymous identity only when the student explicitly continues',async()=>{
  const token=(await create()).url.split('/').at(-1);const a=cookieOf(await join({token,mode:'anonymous',display_name:'학생 가'}));
  const before=await getPrincipal(request('me',undefined,a));const resumed=await join({token,mode:'anonymous',continue:true},a);
  expect(resumed!.headers.get('Set-Cookie')).toBeNull();expect((await getPrincipal(request('me',undefined,a)))?.id).toBe(before!.id);
 });
 it('does not let a blocked anonymous identity rejoin as someone new from the same device',async()=>{
  const token=(await create()).url.split('/').at(-1);const a=cookieOf(await join({token,mode:'anonymous'}));const blocked=await getPrincipal(request('me',undefined,a));
  await (await getDb()).run('INSERT INTO board_blocks(board_id,principal_id,created_at) VALUES($1,$2,$3)',[board.id,blocked!.id,now()]);
  await expect(join({token,mode:'anonymous'},a)).rejects.toMatchObject({code:'FORBIDDEN'});
  await (await getDb()).run('DELETE FROM board_blocks WHERE principal_id=$1',[blocked!.id]);
 });
 it('rate limits code attempts per client before the school-wide backstop',async()=>{
  const key='share.code.ip.'+digest('ip:198.51.100.7').slice(0,24);
  await (await getDb()).run('INSERT INTO rate_limits(key,count,resets_at) VALUES($1,200,$2) ON CONFLICT(key) DO UPDATE SET count=200,resets_at=EXCLUDED.resets_at',[key,new Date(Date.now()+60000).toISOString()]);
  await expect(join({code:'AABBCCDDEE',mode:'anonymous'},undefined,'198.51.100.7')).rejects.toMatchObject({code:'RATE_LIMITED'});
  await expect(join({code:'AABBCCDDEE',mode:'anonymous'},undefined,'198.51.100.8')).rejects.toSatisfy((error:{code?:string})=>error.code!=='RATE_LIMITED');
 });
});
