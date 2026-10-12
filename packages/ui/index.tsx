'use client';
import type { ReactNode } from 'react';
export async function api<T>(path:string,init:RequestInit={}):Promise<T>{const response=await fetch(path,{...init,headers:{...(init.body && !(init.body instanceof FormData)?{'Content-Type':'application/json'}:{}),...init.headers}});const result=await response.json();if(!response.ok)throw new Error(result.error?.message||'요청을 처리하지 못했습니다.');return result.data as T;}
export function EmptyState({title,children}:{title:string;children?:ReactNode}){return <div className="empty-state"><span className="empty-icon">✦</span><h3>{title}</h3><p>{children}</p></div>;}
export function Notice({children}:{children:ReactNode}){return <p className="notice" role="alert">{children}</p>;}
export function Spinner(){return <div className="loading" role="status">불러오는 중…</div>;}
