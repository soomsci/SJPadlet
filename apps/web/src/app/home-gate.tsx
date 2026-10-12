'use client';
import { useState,useEffect } from 'react';
import { ArrowRight,GraduationCap } from 'lucide-react';
import { Dashboard } from '@features/boards';
import { LoginPage } from '@features/auth';
import { api,Spinner,Notice } from '@ui';
import type { Principal } from '@contracts';
export function HomeGate(){const [me,setMe]=useState<{principal:Principal|null}|null>(null);const [error,setError]=useState('');useEffect(()=>{api<{principal:Principal|null}>('/api/me').then(setMe).catch(e=>setError(e.message));},[]);if(error)return <div className="page-container"><Notice>{error}</Notice><button className="button secondary" onClick={()=>window.location.reload()}>다시 시도</button></div>;if(!me)return <Spinner/>;if(!me.principal)return <LoginPage/>;if(['teacher','admin'].includes(me.principal.role))return <Dashboard/>;return <main className="page-container"><div className="card student-home"><GraduationCap size={42}/><span className="eyebrow">OUR LEARNING SPACE</span><h1>오늘은 어떤 생각을 나눌까요?</h1><p>{me.principal.display_name} 님, 선생님이 공유한 QR이나 참여 코드로 수업을 시작하세요.</p><a className="button primary" href="/join">활동 참여하기<ArrowRight size={18}/></a>{me.principal.role==='anonymous'&&<a className="button secondary" href="/login?student=1&returnTo=/join">Google 계정 연결하기</a>}</div></main>;}
