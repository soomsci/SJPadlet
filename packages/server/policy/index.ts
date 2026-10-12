import type { Board, Post, Principal, Share } from '@contracts';
import type { Database } from '@db';
import { fail } from '@server/common/http';

export interface BoardAccess {board:Board;can_manage:boolean;can_write:boolean;submission_only:boolean;shares:Share[];}
export function requireTeacher(principal:Principal):void {
 if(principal.disabled_at || !['teacher','admin'].includes(principal.role))fail(403,'FORBIDDEN','학교 교사 계정이 필요합니다.');
}
export async function canManage(db:Database,principal:Principal,board:Board):Promise<boolean>{
 if(principal.disabled_at)return false;
 const current=await db.one<Principal>('SELECT * FROM principals WHERE id=$1',[principal.id]);
 if(!current||current.disabled_at||!['teacher','admin'].includes(current.role))return false;
 if(board.owner_id===principal.id)return true;
 return Boolean(await db.one('SELECT 1 FROM board_members WHERE board_id=$1 AND principal_id=$2 AND role=$3',[board.id,principal.id,'editor']));
}
export async function boardAccess(db:Database,principal:Principal,boardId:string):Promise<BoardAccess>{
 if(principal.disabled_at)fail(403,'FORBIDDEN','사용 중지된 계정입니다.');
 // Refresh account state for long-lived SSE calls as well as ordinary requests.
 const current=await db.one<Principal>('SELECT * FROM principals WHERE id=$1',[principal.id]);
 if(!current || current.disabled_at)fail(403,'FORBIDDEN','사용할 수 없는 계정입니다.');
 const board=await db.one<Board>('SELECT * FROM boards WHERE id=$1',[boardId]);
 if(!board || board.deleted_at)fail(404,'NOT_FOUND','게시판을 찾을 수 없습니다.');
 const can_manage=await canManage(db,current,board);
 if(can_manage)return {board,can_manage:true,can_write:true,submission_only:false,shares:[]};
 // Read-only co-teachers see the board in every state, like its editors (but never write).
 const reader=['teacher','admin'].includes(current.role) && await db.one('SELECT 1 FROM board_members WHERE board_id=$1 AND principal_id=$2 AND role=$3',[board.id,current.id,'reader']);
 if(reader)return {board,can_manage:false,can_write:false,submission_only:false,shares:[]};
 if(await db.one('SELECT 1 FROM board_blocks WHERE board_id=$1 AND principal_id=$2',[board.id,current.id]))fail(403,'FORBIDDEN','이 게시판의 참여가 차단되었습니다.');
 if(board.state==='draft'||board.state==='archived')fail(404,'NOT_FOUND','게시판을 찾을 수 없습니다.');
 if(board.participation_mode==='login' && current.role==='anonymous')fail(403,'AUTH_REQUIRED','로그인이 필요한 활동입니다.');
 const shares=await db.all<Share>(`SELECT s.* FROM share_links s JOIN participations p ON p.share_id=s.id
 WHERE p.principal_id=$1 AND p.board_id=$2 AND s.board_id=$2 AND p.blocked_at IS NULL
 AND p.share_version=s.version AND s.revoked_at IS NULL AND s.expires_at>$3
 AND ((s.target_type IN ('board','submission') AND s.target_id=s.board_id)
 OR (s.target_type='section' AND EXISTS(SELECT 1 FROM sections x WHERE x.id=s.target_id AND x.board_id=s.board_id AND x.deleted_at IS NULL))
 OR (s.target_type='post' AND EXISTS(SELECT 1 FROM posts x WHERE x.id=s.target_id AND x.board_id=s.board_id AND x.status NOT IN ('deleted','hidden'))))`,[current.id,board.id,new Date().toISOString()]);
 if(!shares.length)fail(404,'NOT_FOUND','참여 권한이 없거나 공유가 만료되었습니다.');
 return {board,can_manage:false,can_write:board.state==='open'&&shares.some(s=>s.scope==='write'),submission_only:shares.every(s=>s.target_type==='submission'),shares};
}
export function canReadPost(access:BoardAccess,principal:Principal,post:Post):boolean{
 if(principal.disabled_at || post.board_id!==access.board.id || post.status==='deleted')return false;
 if(access.can_manage)return true;
 if(post.status==='hidden')return false;
 const readable=post.status==='published'||post.author_id===principal.id;
 if(!readable)return false;
 // A reader membership grants board-wide read access; valid participation grants union.
 if(!access.shares.length)return !access.submission_only;
 return access.shares.some(share=>share.target_type==='submission'?post.author_id===principal.id:share.target_type==='post'?post.id===share.target_id:true);
}

/** Authorizes a write against its particular resource, rather than any grant on the board. */
export function canWritePost(access:BoardAccess,principal:Principal,post:Post):boolean{
 if(!canReadPost(access,principal,post)||!access.can_write)return false;
 if(access.can_manage)return true;
 return access.shares.some(share=>share.scope==='write'&&(share.target_type==='board'||(share.target_type==='section'&&share.target_id===post.section_id)||(share.target_type==='post'&&share.target_id===post.id)||(share.target_type==='submission'&&post.author_id===principal.id)));
}
