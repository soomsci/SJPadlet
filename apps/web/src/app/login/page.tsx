import { LoginPage } from '@features/auth';
export default async function Page({searchParams}:{searchParams:Promise<Record<string,string|undefined>>}){const p=await searchParams;return <LoginPage student={p.student==='1'} returnTo={p.returnTo}/>;}
