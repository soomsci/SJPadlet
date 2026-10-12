import { z } from 'zod';
import { getDb,now,audit,emit } from '@db';
import type { Board,Principal,TeacherAdmission } from '@contracts';
import { requirePrincipal } from '@server/auth';
import { fail,input,json } from '@server/common/http';
import { setting } from '@server/common/runtime';
export async function handleAdmin(req:Request,path:string[]):Promise<Response|null>{if(path[0]!=='admin')return null;const actor=await requirePrincipal(req);if(actor.role!=='admin')fail(403,'FORBIDDEN','학교 관리자만 이용할 수 있습니다.');const db=await getDb();
 if(path[1]==='admissions'&&req.method==='GET')return json(await db.all<TeacherAdmission>('SELECT email,enabled,created_by,created_at FROM teacher_admissions ORDER BY email'));
 if(path[1]==='admissions'&&req.method==='PUT'){
  const data=await input(req,z.object({email:z.string().trim().toLowerCase().pipe(z.email()).refine(email=>email.split('@')[1]==='samjeong.ms.kr','학교 이메일을 입력해주세요.'),enabled:z.boolean()}));
  const protectedAdmins=(setting('ADMIN_EMAILS')||'').split(',').map(email=>email.trim().toLowerCase());
  if(!data.enabled&&(data.email===actor.email?.toLowerCase()||protectedAdmins.includes(data.email)))fail(403,'FORBIDDEN','관리자 권한은 운영 설정에서 관리합니다.');
  const admission=await db.transaction(async tx=>{
   await tx.run('LOCK TABLE teacher_admissions IN SHARE ROW EXCLUSIVE MODE');
   const targets=await tx.all<Principal>('SELECT * FROM principals WHERE lower(email)=$1 FOR UPDATE',[data.email]);
   if(targets.some(target=>target.role==='admin'))fail(403,'FORBIDDEN','관리자 권한은 운영 설정에서 관리합니다.');
   const updated=await tx.one<TeacherAdmission>('INSERT INTO teacher_admissions(email,enabled,created_by,created_at) VALUES($1,$2,$3,$4) ON CONFLICT(email) DO UPDATE SET enabled=EXCLUDED.enabled,created_by=EXCLUDED.created_by,created_at=EXCLUDED.created_at RETURNING *',[data.email,data.enabled,actor.id,now()]);
   for(const target of targets){await tx.run('UPDATE principals SET role=$2 WHERE id=$1',[target.id,data.enabled?'teacher':'student']);await tx.run('DELETE FROM sessions WHERE principal_id=$1',[target.id]);const boards=await tx.all<{id:string}>('SELECT id FROM boards WHERE owner_id=$1 UNION SELECT board_id AS id FROM board_members WHERE principal_id=$1',[target.id]);for(const board of boards)await emit(tx,board.id,'permissions');}
   await audit(tx,actor.id,data.enabled?'teacher.admit':'teacher.revoke',data.email);return updated;
  });return json(admission);
 }
 if(path[1]==='summary'&&req.method==='GET'){const summary=await db.one('SELECT (SELECT count(*) FROM boards WHERE deleted_at IS NULL)::int AS boards,(SELECT count(*) FROM principals WHERE role IN (\'teacher\',\'admin\'))::int AS teachers,(SELECT count(*) FROM posts WHERE status<>\'deleted\')::int AS posts,(SELECT COALESCE(sum(bytes),0) FROM attachments)::text AS bytes');return json(summary);}
 if(path[1]==='audit'&&req.method==='GET')return json(await db.all('SELECT id,actor_id,action,target_id,created_at FROM audit_events ORDER BY created_at DESC LIMIT 100'));
 if(path[1]==='teachers'&&req.method==='GET')return json(await db.all('SELECT id,display_name,email,role,disabled_at,created_at FROM principals WHERE role IN (\'teacher\',\'admin\') ORDER BY display_name'));
 if(path[1]==='teachers'&&req.method==='PATCH'){const data=await input(req,z.object({id:z.string(),disabled:z.boolean()}));if(data.id===actor.id)fail(400,'INVALID_INPUT','자신의 계정은 정지할 수 없습니다.');await db.transaction(async tx=>{const target=await tx.one<Principal>('SELECT * FROM principals WHERE id=$1 FOR UPDATE',[data.id]);if(!target||!['teacher','admin'].includes(target.role))fail(404,'NOT_FOUND','교사를 찾을 수 없습니다.');if(target.role==='admin'&&data.disabled)fail(403,'FORBIDDEN','관리자 계정의 정지는 운영 설정에서 처리해주세요.');await tx.run('UPDATE principals SET disabled_at=$1 WHERE id=$2',[data.disabled?now():null,data.id]);if(data.disabled)await tx.run('DELETE FROM sessions WHERE principal_id=$1',[data.id]);await audit(tx,actor.id,data.disabled?'teacher.disable':'teacher.enable',data.id);});return json({ok:true});}
 if(path[1]==='transfer'&&req.method==='POST'){const data=await input(req,z.object({board_id:z.string(),owner_id:z.string()}));await db.transaction(async tx=>{const board=await tx.one<Board>('SELECT * FROM boards WHERE id=$1 FOR UPDATE',[data.board_id]);const target=await tx.one<Principal>('SELECT * FROM principals WHERE id=$1 FOR UPDATE',[data.owner_id]);if(!board||!target||target.disabled_at||!['teacher','admin'].includes(target.role))fail(400,'INVALID_INPUT','활성 교사와 게시판을 선택해주세요.');await tx.run('UPDATE boards SET owner_id=$1,version=version+1,updated_at=$2 WHERE id=$3',[target.id,now(),board.id]);await tx.run('DELETE FROM board_members WHERE board_id=$1 AND principal_id=$2',[board.id,target.id]);await audit(tx,actor.id,'board.transfer',board.id);await emit(tx,board.id,'permissions');});return json({ok:true});}
 return null;
}
