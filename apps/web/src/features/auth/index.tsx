'use client';
import { useEffect, useState } from 'react';
import { ArrowRight, GraduationCap, ShieldCheck } from 'lucide-react';
import { api, Notice } from '@ui';

interface Me {principal:{id:string;role:string;display_name:string}|null;google_configured:boolean;demo_enabled:boolean;}
export function LoginPage({student=false,returnTo}:{student?:boolean;returnTo?:string}){
 const [status,setStatus]=useState<Me|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const destination=returnTo||(student?'/join':'/dashboard');
 useEffect(()=>{if(new URLSearchParams(window.location.search).get('error')==='cancelled')setError('Google 로그인이 취소되었습니다. 다시 로그인하거나 참여 방식으로 돌아갈 수 있습니다.');api<Me>('/api/me').then(setStatus).catch(e=>setError(e.message));},[]);
 async function demo(){setBusy(true);setError('');try{await api('/api/auth/demo',{method:'POST',body:JSON.stringify({role:student?'student':'teacher'})});window.location.assign(destination.startsWith('/')&&!destination.startsWith('//')&&!/[\\\x00-\x20]/.test(destination)?destination:'/dashboard');}catch(e){setError(e instanceof Error?e.message:'로그인에 실패했습니다.');setBusy(false);}}
 const query=new URLSearchParams({intent:student?'student':'teacher',returnTo:destination});
 return <main className="auth-page"><div className="auth-intro"><span className="badge">삼정학교의 수업 공간</span><h1>생각이 모이면,<br/>수업이 자랍니다.</h1><p>질문을 나누고, 함께 생각하고,<br/>우리 반의 배움을 한곳에 담으세요.</p><div className="auth-illustration" aria-hidden="true"><div className="auth-note">오늘 발견한 것 ✦<br/><strong>작은 생각도 소중해요.</strong></div><div className="auth-note alt">우리의 질문이<br/><strong>배움의 시작이니까.</strong></div></div></div><section className="card auth-card"><GraduationCap size={40} aria-hidden="true"/><h2>{student?'학생 로그인':'선생님, 반가워요'}</h2><p>{student?'Google 계정으로 참여하고 작성한 글을 이어서 확인하세요.':'학교 Google 계정으로 나만의 수업 게시판을 시작하세요.'}</p>{error&&<Notice>{error}</Notice>}
 {status?.google_configured?<a className="button primary" href={`/api/auth/google?${query}`}>Google로 로그인 <ArrowRight size={18}/></a>:<button className="button primary" disabled>{status?'Google 로그인 설정 대기 중':'로그인 확인 중…'}</button>}
 {!status?.google_configured&&status&&<p className="notice">운영자가 Google 로그인 설정을 완료하면 이용할 수 있습니다.</p>}
 <p className="auth-helper"><ShieldCheck size={16}/>{student?'로그인 후에도 공유받은 활동만 열 수 있습니다.':'@samjeong.ms.kr 계정과 등록된 교사 명단을 확인합니다.'}</p>
 {status?.principal?.role==='anonymous'&&student&&status.google_configured&&<div className="auth-link"><p>현재 익명으로 참여 중입니다. 기존 글을 계정에 연결하려면 아래 버튼을 이용하세요.</p><a className="button secondary" href={`/api/auth/google?${new URLSearchParams({intent:'link',returnTo:destination})}`}>내 익명 글을 Google 계정에 연결</a><small>같은 브라우저의 익명 참여 글과 권한이 연결됩니다.</small></div>}
 {status?.demo_enabled&&<div className="auth-demo"><p>로컬 개발 체험입니다. 실제 Google 인증을 사용하지 않습니다.</p><button className="button secondary" disabled={busy} onClick={demo}>{busy?'준비 중…':student?'데모 학생으로 체험':'데모 교사로 체험'}</button></div>}
 <div className="auth-footer">{student?<a href="/join">참여 코드로 돌아가기</a>:<a href="/join">학생인가요? 참여 코드로 입장하기 <ArrowRight size={16}/></a>}</div></section></main>;
}
