import { handleAuth } from '@server/auth';
import { handleBoards } from '@server/boards';
import { handleShares } from '@server/shares';
import { handleMedia } from '@server/media';
import { handleRealtime } from '@server/realtime';
import { handleAdmin } from '@server/admin';
import { handleExports } from '@server/exports';
import { handleParticipants } from '@server/participants';
import { assertSameOrigin,errorResponse,fail } from '@server/common/http';
export const runtime='nodejs';export const dynamic='force-dynamic';
async function dispatch(req:Request,{params}:{params:Promise<{path:string[]}>}){try{assertSameOrigin(req);const {path}=await params;for(const handler of [handleAuth,handleShares,handleMedia,handleRealtime,handleExports,handleAdmin,handleParticipants,handleBoards]){const response=await handler(req,path);if(response)return response;}fail(404,'NOT_FOUND','페이지를 찾을 수 없습니다.');}catch(e){return errorResponse(e);}}
export {dispatch as GET,dispatch as POST,dispatch as PATCH,dispatch as DELETE,dispatch as PUT};
