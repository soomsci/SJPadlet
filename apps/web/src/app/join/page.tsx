import { JoinPage } from '@features/join';
import { Suspense } from 'react';
export default function Page(){return <Suspense fallback={<p>참여 화면을 준비하는 중…</p>}><JoinPage/></Suspense>;}
