import { BoardWorkspace } from '@features/boards';
export default async function Page({params,searchParams}:{params:Promise<{id:string}>;searchParams:Promise<Record<string,string|undefined>>}){const {id}=await params;const p=await searchParams;return <BoardWorkspace boardId={id} postId={p.post} sectionId={p.section} submission={p.submission==='1'}/>;}
