import { getDb } from '@db';
import { requirePrincipal } from '@server/auth';
import { boardAccess } from '@server/policy';
import { getBoardView } from '@server/boards';
import { fail } from '@server/common/http';
export function csvCell(value:unknown){let s=String(value??'');if(/^[\s]*[=+@-]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';}
export async function handleExports(req:Request,path:string[]):Promise<Response|null>{if(req.method!=='GET'||path[0]!=='boards'||path[2]!=='export'||path.length!==3)return null;const principal=await requirePrincipal(req);const db=await getDb();const access=await boardAccess(db,principal,path[1]);if(!access.can_manage)fail(403,'FORBIDDEN','교사만 내보낼 수 있습니다.');const view=await getBoardView(principal,path[1]);const rows=[['제목','내용','작성자','상태','작성 시각 (Asia/Seoul)','좋아요','댓글 수','링크'],...view.posts.map(p=>[p.title,p.body,p.author_name,p.status,new Date(p.created_at).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'}),p.likes,p.comments.length,p.link])];return new Response('\uFEFF'+rows.map(row=>row.map(csvCell).join(',')).join('\r\n'),{headers:{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(view.board.title+'.csv'),'Cache-Control':'private, no-store'}});}
