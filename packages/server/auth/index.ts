import { setting } from '@server/common/runtime';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { OAuth2Client, CodeChallengeMethod, type TokenPayload } from 'google-auth-library';
import { z } from 'zod';
import type { Principal, Role } from '@contracts';
import { getDb, id, now, audit, emit, type Database } from '@db';
import { inTeacherGroup, teacherGroup } from './teacher-group';
import { cookieValue, fail, input, json } from '@server/common/http';

const SESSION='samjeong_session';
const FLOW='samjeong_oauth';
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const random=()=>randomBytes(32).toString('base64url');
const emails=(value:string|undefined)=>(value||'').split(',').map(v=>v.trim().toLowerCase()).filter(Boolean);
function appUrl(){return new URL(setting('APP_URL')||'http://localhost:3000');}
function cookie(name:string,value:string,seconds:number){return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${appUrl().protocol==='https:'?'; Secure':''}`;}
function redirect(path:string,headers?:HeadersInit){return new Response(null,{status:302,headers:{Location:path,'Cache-Control':'no-store',...headers}});}
export function safeReturnTo(value:string|null|undefined):string{
 if(!value || !value.startsWith('/') || value.startsWith('//') || /[\\\x00-\x20]/.test(value))return '/dashboard';
 const base=appUrl();try{const target=new URL(value,base);if(target.origin===base.origin && !target.pathname.startsWith('/api/'))return target.pathname+target.search+target.hash;}catch{}return '/dashboard';
}
export function googleConfigured(){try{return Boolean(setting('GOOGLE_CLIENT_ID')&&setting('GOOGLE_CLIENT_SECRET')&&(setting('NODE_ENV')!=='production'||appUrl().protocol==='https:'));}catch{return false;}}
export function demoEnabled(req:Request){try{const hosts=['localhost','127.0.0.1'];const requestHost=req.headers.get('host');return setting('NODE_ENV')==='development'&&setting('ENABLE_DEMO_LOGIN')==='true'&&hosts.includes(appUrl().hostname)&&hosts.includes(new URL(req.url).hostname)&&Boolean(requestHost&&hosts.includes(new URL(`http://${requestHost}`).hostname));}catch{return false;}}
export async function getPrincipal(req:Request):Promise<Principal|null>{
 let token:string|null;try{token=cookieValue(req,SESSION);}catch{return null;}
 if(!token||!/^[A-Za-z0-9_-]{43}$/.test(token))return null;
 const db=await getDb();return db.one<Principal>(`SELECT p.* FROM sessions s JOIN principals p ON p.id=s.principal_id WHERE s.token_hash=$1 AND s.expires_at>$2 AND p.disabled_at IS NULL`,[digest(token),now()]);
}
export async function requirePrincipal(req:Request):Promise<Principal>{const principal=await getPrincipal(req);if(!principal)fail(401,'AUTH_REQUIRED','로그인하거나 공유 링크로 참여해주세요.');return principal;}
async function sessionFor(db:Database,principal:Principal){const token=random();await db.run('INSERT INTO sessions(id,principal_id,token_hash,expires_at,created_at) VALUES($1,$2,$3,$4,$5)',[id(),principal.id,digest(token),new Date(Date.now()+7*86400000).toISOString(),now()]);return cookie(SESSION,token,7*86400);}
export async function createAnonymousSession(displayName:string):Promise<{principal:Principal;cookie:string}>{
 const name=displayName.trim()||'익명 학생';if(name.length>40)fail(400,'INVALID_INPUT','별명은 40자 이내로 입력해주세요.');
 const db=await getDb();return db.transaction(async tx=>{const principal:Principal={id:id(),role:'anonymous',display_name:name,email:null,disabled_at:null,provider_subject:null,created_at:now()};await tx.run('INSERT INTO principals(id,role,display_name,created_at) VALUES($1,$2,$3,$4)',[principal.id,principal.role,name,principal.created_at]);return {principal,cookie:await sessionFor(tx,principal)};});
}
export function googleRole(payload:Pick<TokenPayload,'sub'|'email'|'email_verified'|'hd'>,intent:string):Role{
 if(!payload.sub||!payload.email||payload.email_verified!==true)fail(403,'FORBIDDEN','인증된 Google 이메일 계정이 필요합니다.');
 const email=payload.email.toLowerCase();const exactSchool=email.split('@').length===2&&email.split('@')[1]==='samjeong.ms.kr'&&payload.hd==='samjeong.ms.kr';
 const admin=exactSchool&&emails(setting('ADMIN_EMAILS')).includes(email);
 const teacher=exactSchool&&(setting('TEACHER_ADMISSION')==='domain'||emails(setting('TEACHER_EMAILS')||setting('TEACHER_ALLOWLIST')).includes(email));
 if(intent==='teacher'&&!admin&&!teacher)fail(403,'TEACHER_NOT_ADMITTED','학교 교사 명단에 등록된 계정으로 로그인해주세요. 학생은 학생 참여를 이용해주세요.');
 return admin?'admin':teacher?'teacher':'student';
}
const isExactSchool=(payload:Pick<TokenPayload,'email'|'hd'>)=>{const email=(payload.email||'').toLowerCase();return email.split('@').length===2&&email.split('@')[1]==='samjeong.ms.kr'&&payload.hd==='samjeong.ms.kr';};
/** Teacher-group membership for a verified school login: undefined = not needed/configured, null = lookup failed. */
export async function teacherGroupMembership(payload:Pick<TokenPayload,'sub'|'email'|'email_verified'|'hd'>):Promise<boolean|null|undefined>{
 if(!teacherGroup()||!isExactSchool(payload)||payload.email_verified!==true||googleRole(payload,'student')!=='student')return undefined;
 try{return await inTeacherGroup(payload.email!.toLowerCase());}catch(error){console.warn('Teacher group lookup failed:',(error as Error).message);return null;}
}
/**
 * Database admission overrides env lists and the teacher group, while operator-managed admins remain protected.
 * Group membership is looked up before the caller's transaction so no lock is held during the Google API call.
 */
export async function googleAdmissionRole(db:Database,payload:Pick<TokenPayload,'sub'|'email'|'email_verified'|'hd'>,intent:string,groupMember?:boolean|null):Promise<Role>{
 let role=googleRole(payload,'student');
 const exactSchool=isExactSchool(payload);
 const admission=role!=='admin'&&exactSchool?await db.one<{enabled:boolean}>('SELECT enabled FROM teacher_admissions WHERE email=$1',[payload.email!.toLowerCase()]):null;
 if(admission)role=admission.enabled?'teacher':'student';
 else if(role==='student'&&exactSchool&&groupMember===true)role='teacher';
 if(intent==='teacher'&&role==='student'&&!admission&&groupMember===null)fail(503,'TEACHER_GROUP_UNAVAILABLE','교사 그룹을 확인하지 못했습니다. 잠시 후 다시 로그인해주세요.');
 if(intent==='teacher'&&!['teacher','admin'].includes(role))fail(403,'TEACHER_NOT_ADMITTED','학교 교사 명단에 등록된 계정으로 로그인해주세요. 학생은 학생 참여를 이용해주세요.');
 return role;
}
/** Changes a role and ends the account's sessions so already-loaded permissions cannot outlive the change. */
export async function applyRole(tx:Database,principalId:string,role:Role){
 await tx.run('UPDATE principals SET role=$2 WHERE id=$1',[principalId,role]);
 await tx.run('DELETE FROM sessions WHERE principal_id=$1',[principalId]);
 const boards=await tx.all<{id:string}>('SELECT id FROM boards WHERE owner_id=$1 UNION SELECT board_id AS id FROM board_members WHERE principal_id=$1',[principalId]);
 for(const board of boards)await emit(tx,board.id,'permissions');
}
/** Daily: demote teachers admitted only through the group who have left it. Throws on lookup failure without demoting. */
export async function recheckTeacherGroup(db:Database):Promise<number>{
 if(!teacherGroup()||setting('TEACHER_ADMISSION')==='domain')return 0;
 const listed=new Set([...emails(setting('ADMIN_EMAILS')),...emails(setting('TEACHER_EMAILS')||setting('TEACHER_ALLOWLIST'))]);
 const teachers=await db.all<{id:string;email:string}>("SELECT p.id,lower(p.email) AS email FROM principals p WHERE p.role='teacher' AND p.email IS NOT NULL AND NOT EXISTS(SELECT 1 FROM teacher_admissions a WHERE a.email=lower(p.email))");
 let demoted=0;
 // ponytail: one token request per teacher; fine for a school's staff list, cache the token per run if it grows.
 for(const teacher of teachers){
  if(listed.has(teacher.email)||await inTeacherGroup(teacher.email))continue;
  await db.transaction(async tx=>{await applyRole(tx,teacher.id,'student');await audit(tx,'scheduled','teacher.group_revoke',teacher.id);});demoted++;
 }
 return demoted;
}
function oauthClient(){if(!googleConfigured())fail(503,'AUTH_NOT_CONFIGURED','Google 로그인이 아직 설정되지 않았습니다.');return new OAuth2Client(setting('GOOGLE_CLIENT_ID'),setting('GOOGLE_CLIENT_SECRET'),new URL('/api/auth/google/callback',appUrl()).href);}
interface Flow {id:string;state_hash:string;nonce:string;code_verifier:string;return_to:string;intent:string;previous_principal_id:string|null;expires_at:string;}
export async function linkAnonymous(tx:Database,previous:Principal,target:Principal){
 const owned=await tx.one<Principal>('SELECT * FROM principals WHERE id=$1 FOR UPDATE',[previous.id]);
 if(!owned||owned.role!=='anonymous'||owned.disabled_at||target.role==='anonymous'||target.disabled_at)fail(403,'FORBIDDEN','계정을 연결할 수 없습니다.');
 // Persistent board-level blocks survive identity linking, including future invite links.
 await tx.run('INSERT INTO board_blocks(board_id,principal_id,created_at) SELECT board_id,$2,created_at FROM board_blocks WHERE principal_id=$1 ON CONFLICT(board_id,principal_id) DO NOTHING',[previous.id,target.id]);
 // A blocked participation stays blocked when accounts are explicitly linked.
 await tx.run(`UPDATE participations p SET blocked_at=COALESCE(p.blocked_at,old.blocked_at),share_version=GREATEST(p.share_version,old.share_version) FROM participations old WHERE old.principal_id=$1 AND p.principal_id=$2 AND old.share_id=p.share_id`,[previous.id,target.id]);
 await tx.run('DELETE FROM participations p WHERE p.principal_id=$1 AND EXISTS(SELECT 1 FROM participations other WHERE other.principal_id=$2 AND other.share_id=p.share_id)',[previous.id,target.id]);
 await tx.run('UPDATE participations SET principal_id=$2 WHERE principal_id=$1',[previous.id,target.id]);
 await tx.run('UPDATE posts SET author_id=$2 WHERE author_id=$1',[previous.id,target.id]);
 await tx.run('UPDATE comments SET author_id=$2 WHERE author_id=$1',[previous.id,target.id]);
 await tx.run('UPDATE attachments SET uploader_id=$2 WHERE uploader_id=$1',[previous.id,target.id]);
 await tx.run('UPDATE post_drafts SET principal_id=$2 WHERE principal_id=$1',[previous.id,target.id]);
 await tx.run('DELETE FROM reactions r WHERE r.principal_id=$1 AND EXISTS(SELECT 1 FROM reactions other WHERE other.principal_id=$2 AND other.post_id=r.post_id)',[previous.id,target.id]);
 await tx.run('UPDATE reactions SET principal_id=$2 WHERE principal_id=$1',[previous.id,target.id]);
 await tx.run('DELETE FROM sessions WHERE principal_id=$1',[previous.id]);
 await tx.run('INSERT INTO favorites(principal_id,board_id) SELECT $2,board_id FROM favorites WHERE principal_id=$1 ON CONFLICT DO NOTHING',[previous.id,target.id]);
 await tx.run('DELETE FROM favorites WHERE principal_id=$1',[previous.id]);
 await tx.run('INSERT INTO idempotency(principal_id,key,result_id,created_at) SELECT $2,key,result_id,created_at FROM idempotency WHERE principal_id=$1 ON CONFLICT DO NOTHING',[previous.id,target.id]);
 await tx.run('DELETE FROM idempotency WHERE principal_id=$1',[previous.id]);
 await tx.run('DELETE FROM board_blocks WHERE principal_id=$1',[previous.id]);
 // Deleting the source makes concurrent FK-backed writes wait, then fail safely.
 // A disabled tombstone would let an in-flight INSERT commit after ownership migration.
 await tx.run('DELETE FROM principals WHERE id=$1',[previous.id]);
 await audit(tx,target.id,'anonymous.link',previous.id);
}
async function start(req:Request){
 const client=oauthClient(),url=new URL(req.url),intent=url.searchParams.get('intent')||'student';
 if(!['teacher','student','link'].includes(intent))fail(400,'INVALID_INPUT','로그인 방법을 확인해주세요.');
 const previous=await getPrincipal(req);if(intent==='link'&&previous?.role!=='anonymous')fail(403,'FORBIDDEN','연결할 익명 참여 세션이 없습니다.');
 const state=random(),nonce=random(),verifier=random(),flowCookie=random(),db=await getDb();
 // Cookie binding blocks login CSRF even when a valid OAuth state is leaked.
 await db.run('DELETE FROM oauth_states WHERE expires_at<$1',[now()]);
 await db.run('INSERT INTO oauth_states(id,state_hash,nonce,code_verifier,return_to,intent,previous_principal_id,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[digest(flowCookie),digest(state),nonce,verifier,safeReturnTo(url.searchParams.get('returnTo')),intent,intent==='link'?previous!.id:null,new Date(Date.now()+600000).toISOString()]);
 const destination=client.generateAuthUrl({access_type:'online',scope:['openid','email','profile'],state,nonce,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:CodeChallengeMethod.S256,prompt:'select_account',...(intent==='teacher'?{hd:'samjeong.ms.kr'}:{})});
 return redirect(destination,{'Set-Cookie':cookie(FLOW,flowCookie,600)});
}
async function callback(req:Request){
 const url=new URL(req.url),state=url.searchParams.get('state'),code=url.searchParams.get('code');let binding:string|null=null;try{binding=cookieValue(req,FLOW);}catch{}
 if(!state||!binding)fail(400,'INVALID_OAUTH_STATE','로그인 요청이 만료되었습니다. 다시 시작해주세요.');
 const db=await getDb();const flow=await db.transaction(async tx=>{const found=await tx.one<Flow>('DELETE FROM oauth_states WHERE state_hash=$1 AND id=$2 AND expires_at>$3 RETURNING *',[digest(state),digest(binding!),now()]);if(!found)fail(400,'INVALID_OAUTH_STATE','로그인 요청이 만료되었습니다. 다시 시작해주세요.');return found;});
 const previous=await getPrincipal(req);if(flow.intent==='link'&&(!previous||previous.id!==flow.previous_principal_id||previous.role!=='anonymous'))fail(403,'FORBIDDEN','기존 익명 참여 세션을 확인할 수 없습니다.');
 if(url.searchParams.has('error')||!code){const query=new URLSearchParams({error:'cancelled',returnTo:flow.return_to,...(flow.intent==='teacher'?{}:{student:'1'})});return redirect('/login?'+query,{'Set-Cookie':cookie(FLOW,'',0)});}
 const client=oauthClient();let payload:TokenPayload|undefined;
 try{const {tokens}=await client.getToken({code,codeVerifier:flow.code_verifier});if(!tokens.id_token)throw new Error('Missing identity token');const ticket=await client.verifyIdToken({idToken:tokens.id_token,audience:setting('GOOGLE_CLIENT_ID')});payload=ticket.getPayload();}catch{fail(403,'GOOGLE_AUTH_FAILED','Google 인증을 확인하지 못했습니다. 다시 로그인해주세요.');}
 const nonce=(payload as TokenPayload&{nonce?:string})?.nonce;
 if(!payload||!nonce||nonce.length!==flow.nonce.length||!timingSafeEqual(Buffer.from(nonce),Buffer.from(flow.nonce)))fail(403,'INVALID_OAUTH_NONCE','Google 인증 요청이 일치하지 않습니다.');
 const email=payload.email!.toLowerCase(),groupMember=await teacherGroupMembership(payload);
 const result=await db.transaction(async tx=>{await tx.run('LOCK TABLE teacher_admissions IN SHARE ROW EXCLUSIVE MODE');const role=await googleAdmissionRole(tx,payload!,flow.intent,groupMember);let principal=await tx.one<Principal>('SELECT * FROM principals WHERE provider_subject=$1 FOR UPDATE',[payload!.sub]);if(principal?.disabled_at)fail(403,'FORBIDDEN','사용 중지된 계정입니다.');
 if(principal){await tx.run('UPDATE principals SET display_name=$2,email=$3,role=$4 WHERE id=$1',[principal.id,(payload!.name||'학생').slice(0,80),email,role]);principal={...principal,display_name:(payload!.name||'학생').slice(0,80),email,role};}
 else{principal={id:id(),role,display_name:(payload!.name||'학생').slice(0,80),email,provider_subject:payload!.sub,disabled_at:null,created_at:now()};await tx.run('INSERT INTO principals(id,role,display_name,email,provider_subject,created_at) VALUES($1,$2,$3,$4,$5,$6)',[principal.id,role,principal.display_name,email,principal.provider_subject,principal.created_at]);}
 if(flow.intent==='link')await linkAnonymous(tx,previous!,principal);
 await audit(tx,principal.id,'auth.google',principal.id);return {principal,cookie:await sessionFor(tx,principal)};}).catch((error:unknown)=>{if(error&&typeof error==='object'&&'code' in error&&error.code==='23503')fail(409,'CONFLICT','작성 중인 작업이 있어 계정을 연결하지 못했습니다. 기존 익명 참여는 보존되었습니다. 잠시 후 다시 연결해주세요.');throw error;});
 const headers=new Headers({'Location':flow.return_to,'Cache-Control':'no-store'});headers.append('Set-Cookie',result.cookie);headers.append('Set-Cookie',cookie(FLOW,'',0));return new Response(null,{status:302,headers});
}
export async function handleAuth(req:Request,segments:string[]):Promise<Response|null>{
 const path=segments.join('/');
 if(path==='me'&&req.method==='GET'){const principal=await getPrincipal(req);return json({principal:principal?{id:principal.id,role:principal.role,display_name:principal.display_name,email:principal.role==='anonymous'?null:principal.email}:null,google_configured:googleConfigured(),demo_enabled:demoEnabled(req)});}
 if(path==='auth/google'&&req.method==='GET')return start(req);
 if(path==='auth/google/callback'&&req.method==='GET')return callback(req);
 if(path==='auth/logout'&&req.method==='POST'){let token:string|null=null;try{token=cookieValue(req,SESSION);}catch{}if(token)await (await getDb()).run('DELETE FROM sessions WHERE token_hash=$1',[digest(token)]);return json({ok:true},200,{'Set-Cookie':cookie(SESSION,'',0)});}
 if(path==='auth/demo'&&req.method==='POST'){
  if(!demoEnabled(req))fail(404,'NOT_FOUND','요청을 찾을 수 없습니다.');
  const body=await input(req,z.object({role:z.enum(['teacher','student'])}));const db=await getDb();
  const result=await db.transaction(async tx=>{const subject=body.role==='teacher'?'local-demo-teacher':`local-demo-student-${id()}`;let principal=await tx.one<Principal>('SELECT * FROM principals WHERE provider_subject=$1',[subject]);if(principal?.disabled_at)fail(403,'FORBIDDEN','사용 중지된 데모 계정입니다.');if(!principal){principal={id:id(),role:body.role,display_name:body.role==='teacher'?'데모 선생님':'데모 학생',email:body.role==='teacher'?'demo@samjeong.ms.kr':'student@example.invalid',provider_subject:subject,disabled_at:null,created_at:now()};await tx.run('INSERT INTO principals(id,role,display_name,email,provider_subject,created_at) VALUES($1,$2,$3,$4,$5,$6)',[principal.id,principal.role,principal.display_name,principal.email,subject,principal.created_at]);}return {principal,cookie:await sessionFor(tx,principal)};});
  return json({role:result.principal.role},200,{'Set-Cookie':result.cookie});
 }
 return null;
}
