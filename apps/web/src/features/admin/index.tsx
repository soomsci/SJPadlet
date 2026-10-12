'use client';
import { useState,useEffect,useCallback } from 'react';
import { ShieldCheck,Users,LayoutGrid,HardDrive,FileText,UserPlus } from 'lucide-react';
import type { TeacherAdmission } from '@contracts';
import { api,Notice,Spinner } from '@ui';
import { OperationsPanel } from '@features/operations';
type Teacher={id:string;display_name:string;email:string;role:string;disabled_at:string|null};
type Summary={boards:number;teachers:number;posts:number;bytes:string};
type Audit={id:string;action:string;target_id:string;created_at:string};
export function AdminPage(){
 const [teachers,setTeachers]=useState<Teacher[]>([]),[admissions,setAdmissions]=useState<TeacherAdmission[]>([]);
 const [summary,setSummary]=useState<Summary|null>(null),[events,setEvents]=useState<Audit[]>([]);
 const [error,setError]=useState(''),[notice,setNotice]=useState(''),[boardId,setBoardId]=useState(''),[ownerId,setOwnerId]=useState('');
 const [email,setEmail]=useState(''),[savingAdmission,setSavingAdmission]=useState(false);
 const load=useCallback(async()=>{try{
  const [t,s,e,a]=await Promise.all([api<Teacher[]>('/api/admin/teachers'),api<Summary>('/api/admin/summary'),api<Audit[]>('/api/admin/audit'),api<TeacherAdmission[]>('/api/admin/admissions')]);
  setTeachers(t);setSummary(s);setEvents(e);setAdmissions(a);
 }catch(e){setError(e instanceof Error?e.message:'학교 관리를 불러오지 못했습니다.');}},[]);
 useEffect(()=>{void load();},[load]);
 async function toggle(t:Teacher){try{setError('');await api('/api/admin/teachers',{method:'PATCH',body:JSON.stringify({id:t.id,disabled:!t.disabled_at})});await load();}catch(e){setError((e as Error).message);}}
 async function admit(targetEmail:string,enabled:boolean){
  setSavingAdmission(true);setError('');setNotice('');
  try{await api('/api/admin/admissions',{method:'PUT',body:JSON.stringify({email:targetEmail,enabled})});setNotice(enabled?'교사 허용 명단에 등록했습니다. 해당 선생님은 Google로 다시 로그인해주세요.':'교사 권한과 기존 로그인 세션을 해제했습니다.');if(enabled)setEmail('');await load();}catch(e){setError((e as Error).message);}finally{setSavingAdmission(false);}
 }
 async function transfer(e:React.FormEvent){e.preventDefault();try{setError('');await api('/api/admin/transfer',{method:'POST',body:JSON.stringify({board_id:boardId,owner_id:ownerId})});setNotice('소유권을 이전했습니다.');await load();}catch(e){setError((e as Error).message);}}
 return <div className="page-container">
  <div className="page-header"><div><span className="eyebrow"><ShieldCheck size={15}/> SCHOOL ADMIN</span><h1>학교 관리</h1><p>선생님 계정과 학교 공간을 관리하세요.</p></div></div>
  {error&&<Notice>{error}</Notice>}{notice&&<Notice>{notice}</Notice>}
  {!summary&&!error?<Spinner/>:<>
   <div className="stat-grid">{[[Users,'선생님',summary?.teachers],[LayoutGrid,'게시판',summary?.boards],[FileText,'게시글',summary?.posts],[HardDrive,'저장 용량',((Number(summary?.bytes)||0)/1024**2).toFixed(1)+' MB']].map(([Icon,label,value])=>{const C=Icon as typeof Users;return <div className="card stat-card" key={String(label)}><C size={20}/><span>{String(label)}</span><strong>{String(value??0)}</strong></div>;})}</div>
   <section className="card admin-section">
    <h2>교사 허용 명단</h2><p className="muted">삼정중학교 Google 계정을 등록하면 교사로 로그인할 수 있습니다. 허용을 해제하면 교사 권한과 기존 로그인 세션이 즉시 해제됩니다. 계정이 정지된 경우 아래에서 별도로 활성화해주세요.</p>
    <form className="toolbar" onSubmit={e=>{e.preventDefault();void admit(email,true);}}><label className="field">학교 이메일<input className="input" type="email" required maxLength={254} autoComplete="off" placeholder="teacher@samjeong.ms.kr" value={email} onChange={e=>setEmail(e.target.value)}/></label><button className="button primary" disabled={savingAdmission}><UserPlus size={16}/>{savingAdmission?'저장 중…':'교사 등록'}</button></form>
    <div className="table-wrap"><table><thead><tr><th>학교 계정</th><th>교사 로그인</th><th>관리</th></tr></thead><tbody>{admissions.map(admission=><tr key={admission.email}><td>{admission.email}</td><td>{admission.enabled?'허용':'해제'}</td><td><button className="button secondary small" disabled={savingAdmission} onClick={()=>void admit(admission.email,!admission.enabled)}>{admission.enabled?'허용 해제':'다시 허용'}</button></td></tr>)}</tbody></table></div>
    {!admissions.length&&<p className="muted">화면에서 추가한 교사가 아직 없습니다. 운영 설정의 기존 허용 명단은 계속 적용됩니다.</p>}
    <p className="muted">관리자 권한은 운영 설정에서 관리합니다. 학생은 교사 명단 등록 없이 Google 로그인 또는 익명으로 초대받은 활동에 참여할 수 있습니다.</p>
   </section>
   <section className="card admin-section"><h2>선생님 계정</h2><div className="table-wrap"><table><thead><tr><th>이름</th><th>학교 계정</th><th>권한</th><th>상태</th><th>관리</th></tr></thead><tbody>{teachers.map(t=><tr key={t.id}><td>{t.display_name}</td><td>{t.email}</td><td>{t.role==='admin'?'관리자':'교사'}</td><td>{t.disabled_at?'정지':'활성'}</td><td>{t.role!=='admin'&&<button className="button secondary small" onClick={()=>void toggle(t)}>{t.disabled_at?'활성화':'정지'}</button>}</td></tr>)}</tbody></table></div><p className="muted">허용 명단 등록 후 처음 Google 로그인한 선생님도 이 목록에 표시됩니다.</p></section>
   <section className="card admin-section"><h2>게시판 소유권 이전</h2><form onSubmit={transfer} className="toolbar"><label className="field">게시판 ID<input className="input" required value={boardId} onChange={e=>setBoardId(e.target.value)}/></label><label className="field">새 소유 교사<select className="select" required value={ownerId} onChange={e=>setOwnerId(e.target.value)}><option value="">선택해주세요</option>{teachers.filter(t=>!t.disabled_at).map(t=><option value={t.id} key={t.id}>{t.display_name}</option>)}</select></label><button className="button primary">소유권 이전</button></form></section>
   <OperationsPanel/>
   <section className="card admin-section"><h2>최근 운영 기록</h2><div className="audit-list">{events.map(event=><div key={event.id}><span className="badge">{event.action}</span><code>{event.target_id}</code><time>{new Date(event.created_at).toLocaleString('ko-KR')}</time></div>)}</div></section>
  </>}
 </div>;
}
