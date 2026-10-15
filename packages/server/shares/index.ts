import { setting } from '@server/common/runtime';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Board, Share } from '@contracts';
import { shareInput } from '@contracts';
import { audit, emit, getDb, id, now, type Database } from '@db';
import { createAnonymousSession, endSession, getPrincipal, requirePrincipal } from '@server/auth';
import { canManage } from '@server/policy';
import { fail, input, json } from '@server/common/http';

const hash = (value:string) => createHash('sha256').update(value).digest('hex');
const normalizeCode = (value:string) => value.replace(/[\s-]/g,'').toUpperCase();
// Cloudflare sets CF-Connecting-IP and overwrites client copies. On the self-hosted server Caddy is the only entry point and
// replaces X-Forwarded-For with the real peer address (the app port is not published). Only a hash is kept as a rate-limit key.
const client = (req:Request) => hash('ip:'+(req.headers.get('cf-connecting-ip')||req.headers.get('x-forwarded-for')?.split(',')[0].trim()||'unknown')).slice(0,24);
const joinInput = z.object({token:z.string().min(20).max(200).optional(),code:z.string().min(4).max(30).optional(),mode:z.enum(['anonymous','login']),display_name:z.string().trim().max(40).optional(),continue:z.boolean().optional()}).refine(v=>Boolean(v.token)!==Boolean(v.code),'링크 또는 참여 코드 하나를 입력해주세요.');
const metadata = (share:Share) => ({id:share.id,board_id:share.board_id,target_type:share.target_type,target_id:share.target_id,scope:share.scope,expires_at:share.expires_at,revoked_at:share.revoked_at,version:share.version,created_at:share.created_at});

/** Atomic DB counters also work across server instances. Raw tokens/codes never become keys. */
async function limit(db:Database,key:string,max:number,seconds=60){
 const reset=new Date(Date.now()+seconds*1000).toISOString();
 const row=await db.one<{count:number}>(`INSERT INTO rate_limits(key,count,resets_at) VALUES($1,1,$2) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN rate_limits.resets_at < $3 THEN 1 ELSE rate_limits.count+1 END,resets_at=CASE WHEN rate_limits.resets_at < $3 THEN $2 ELSE rate_limits.resets_at END RETURNING count`,[key,reset,now()]);
 if(row && row.count>max)fail(429,'RATE_LIMITED','입력 시도가 많습니다. 잠시 후 다시 시도해주세요.');
}
async function lookup(db:Database,token?:string,code?:string,lock=false){
 const value=token?hash(token):hash(normalizeCode(code||''));
 const share=await db.one<Share>(`SELECT * FROM share_links WHERE ${token?'token_hash':'code_hash'}=$1${lock?' FOR UPDATE':''}`,[value]);
 if(!share || share.revoked_at || Date.parse(share.expires_at)<=Date.now())fail(404,'SHARE_EXPIRED','사용할 수 없거나 만료된 초대입니다. 선생님께 새 링크를 요청해주세요.');
 const board=await db.one<Board>('SELECT * FROM boards WHERE id=$1',[share.board_id]);
 if(!board || board.deleted_at || !['open','closed'].includes(board.state))fail(404,'NOT_FOUND','지금 참여할 수 없는 활동입니다.');
 await validateTarget(db,share,board);
 return {share,board};
}
async function validateTarget(db:Database,target:Pick<Share,'target_type'|'target_id'>,board:Board){
 if(target.target_type==='board'||target.target_type==='submission'){
  if(target.target_id!==board.id)fail(400,'INVALID_INPUT','공유 대상이 게시판과 일치하지 않습니다.');
 }else{
  const table=target.target_type==='post'?'posts':'sections';
  const exists=await db.one<{id:string}>(`SELECT id FROM ${table} WHERE id=$1 AND board_id=$2${table==='posts'?" AND status='published'":' AND deleted_at IS NULL'}`,[target.target_id,board.id]);
  if(!exists)fail(404,'NOT_FOUND','공유할 수 없는 대상입니다.');
 }
}
function destination(share:Share){
 const base='/boards/'+encodeURIComponent(share.board_id);
 if(share.target_type==='post')return base+'?post='+encodeURIComponent(share.target_id);
 if(share.target_type==='section')return base+'?section='+encodeURIComponent(share.target_id);
 return share.target_type==='submission'?base+'?submission=1':base;
}
export async function handleShares(req:Request,segments:string[]):Promise<Response|null>{
 const route=segments.join('/');
 if(route==='shares' && req.method==='POST'){
  const principal=await requirePrincipal(req);const data=await input(req,shareInput);const db=await getDb();
  const result=await db.transaction(async tx=>{
   const board=await tx.one<Board>('SELECT * FROM boards WHERE id=$1 FOR UPDATE',[data.board_id]);
   if(!board||board.deleted_at||!await canManage(tx,principal,board))fail(404,'NOT_FOUND','공유할 수 없는 게시판입니다.');
   await validateTarget(tx,data,board);
   const token=randomBytes(32).toString('base64url');
   // 40 random bits; unique hash constraint prevents accidental collisions.
   let code='';for(let attempt=0;attempt<8;attempt++){code=randomBytes(5).toString('hex').toUpperCase();if(!await tx.one('SELECT id FROM share_links WHERE code_hash=$1',[hash(code)]))break;if(attempt===7)fail(503,'RETRY','다시 시도해주세요.');}
   const shareId=id();const expires=new Date(Date.now()+data.expires_hours*3600000).toISOString();
   await tx.run('INSERT INTO share_links(id,board_id,target_type,target_id,scope,token_hash,code_hash,expires_at,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[shareId,board.id,data.target_type,data.target_id,data.scope,hash(token),hash(code),expires,now()]);
   await audit(tx,principal.id,'share.create',shareId,board.id);
   // SHARE_URL is the short redirect host printed in links/QR; it forwards the same path to APP_URL.
   const origin=new URL(setting('SHARE_URL')||setting('APP_URL')||'http://localhost:3000').origin;
   return {id:shareId,url:origin+'/s/'+token,code,expires_at:expires,target_type:data.target_type,target_id:data.target_id};
  });return json(result,201);
 }
 if(segments[0]==='boards' && segments[2]==='shares' && segments.length===3 && req.method==='GET'){
  const principal=await requirePrincipal(req);const db=await getDb();const board=await db.one<Board>('SELECT * FROM boards WHERE id=$1',[segments[1]]);
  if(!board||board.deleted_at||!await canManage(db,principal,board))fail(404,'NOT_FOUND','게시판을 찾을 수 없습니다.');
  return json((await db.all<Share>('SELECT * FROM share_links WHERE board_id=$1 ORDER BY created_at DESC',[board.id])).map(metadata));
 }
 if(segments[0]==='shares'&&segments[2]==='revoke'&&segments.length===3&&req.method==='POST'){
  const principal=await requirePrincipal(req);const db=await getDb();await db.transaction(async tx=>{
   const initial=await tx.one<Share>('SELECT * FROM share_links WHERE id=$1',[segments[1]]);if(!initial)fail(404,'NOT_FOUND','초대를 찾을 수 없습니다.');
   const board=await tx.one<Board>('SELECT * FROM boards WHERE id=$1 FOR UPDATE',[initial.board_id]);if(!board||!await canManage(tx,principal,board))fail(404,'NOT_FOUND','초대를 찾을 수 없습니다.');
   const share=await tx.one<Share>('SELECT * FROM share_links WHERE id=$1 FOR UPDATE',[initial.id]);if(!share)fail(404,'NOT_FOUND','초대를 찾을 수 없습니다.');
   if(!share.revoked_at){await tx.run('UPDATE share_links SET revoked_at=$1,version=version+1 WHERE id=$2',[now(),share.id]);await audit(tx,principal.id,'share.revoke',share.id,share.board_id);await emit(tx,board.id,'access_changed');}
  });return json({revoked:true});
 }
 if(route==='share-preview'&&req.method==='GET'){
  const url=new URL(req.url);const token=url.searchParams.get('token')||undefined;const code=url.searchParams.get('code')||undefined;
  if(Boolean(token)===Boolean(code)||(token?.length||0)>200||(code?.length||0)>30)fail(400,'INVALID_INPUT','올바른 초대를 입력해주세요.');
  const db=await getDb(),ip=client(req);await limit(db,'share.preview.ip.'+ip,300);await limit(db,'share.preview.global',3000);if(code){await limit(db,'share.code.ip.'+ip,200);await limit(db,'share.code.global',1200);}
  const {board}=await lookup(db,token,code);
  return json({participation_mode:board.participation_mode});
 }
 if(route==='join'&&req.method==='POST'){
  const data=await input(req,joinInput);const db=await getDb();let principal=await getPrincipal(req);
  // Per-client buckets first so one client cannot exhaust the school-wide backstops.
  const ip=client(req);
  if(principal)await limit(db,'share.join.'+principal.id,90);else{await limit(db,'share.join.ip.'+ip,200);await limit(db,'share.join.anonymous',3000);}
  if(data.code){await limit(db,'share.code.ip.'+ip,200);await limit(db,'share.code.global',1200);}
  const initial=await lookup(db,data.token,data.code);
  if(initial.board.participation_mode==='login'&&data.mode==='anonymous')fail(403,'LOGIN_REQUIRED','이 활동은 Google 로그인이 필요합니다.');
  if(data.mode==='login'&&(!principal||principal.role==='anonymous'))fail(401,'AUTH_REQUIRED','Google 로그인 후 참여해주세요.');
  let cookie:string|undefined;
  // Shared classroom devices: a previous student's anonymous identity is reused only on explicit request.
  if(data.mode==='anonymous'&&!(principal?.role==='anonymous'&&data.continue===true)){
   if(principal?.role==='anonymous'&&await db.one('SELECT 1 FROM board_blocks WHERE board_id=$1 AND principal_id=$2',[initial.board.id,principal.id]))fail(403,'FORBIDDEN','참여가 제한되었습니다. 선생님께 문의해주세요.');
   // The new anonymous cookie replaces whatever session this device had (the join page warns signed-in users); end it server side too.
   if(principal)await endSession(db,req);
   const session=await createAnonymousSession(data.display_name||'익명 학생');principal=session.principal;cookie=session.cookie;}
  if(!principal)fail(401,'AUTH_REQUIRED','참여 방식을 선택해주세요.');
  const participant=principal;
  const result=await db.transaction(async tx=>{
   // All board mutations use board -> share lock order, so revocation and writes serialize.
   await tx.one('SELECT id FROM boards WHERE id=$1 FOR UPDATE',[initial.board.id]);
   const {share,board}=await lookup(tx,data.token,data.code,true);
   if(board.participation_mode==='login'&&participant.role==='anonymous')fail(403,'LOGIN_REQUIRED','이 활동은 Google 로그인이 필요합니다.');
   if(await tx.one('SELECT 1 FROM board_blocks WHERE board_id=$1 AND principal_id=$2',[board.id,participant.id]))fail(403,'FORBIDDEN','참여가 제한되었습니다. 선생님께 문의해주세요.');
   const existing=await tx.one<{blocked_at:string|null}>('SELECT blocked_at FROM participations WHERE principal_id=$1 AND share_id=$2',[participant.id,share.id]);
   if(existing?.blocked_at)fail(403,'FORBIDDEN','참여가 제한되었습니다. 선생님께 문의해주세요.');
   await tx.run('INSERT INTO participations(id,principal_id,board_id,share_id,share_version,created_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(principal_id,share_id) DO UPDATE SET share_version=EXCLUDED.share_version',[id(),participant.id,board.id,share.id,share.version,now()]);
   return {board_id:board.id,target_type:share.target_type,target_id:share.target_id,destination:destination(share)};
  });return json(result,200,cookie?{'Set-Cookie':cookie}:undefined);
 }
 return null;
}
