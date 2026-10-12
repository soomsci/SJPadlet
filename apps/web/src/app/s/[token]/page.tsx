import { JoinPage } from '@features/join';
export default async function Page({params}:{params:Promise<{token:string}>}){return <JoinPage token={(await params).token}/>;}
