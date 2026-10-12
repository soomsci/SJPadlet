import { setting } from '@server/common/runtime';
import { json, fail } from '@server/common/http';
import { realtimeTicket } from './ticket';
import { getDb } from '@db';
import { requirePrincipal,getPrincipal } from '@server/auth';
import { boardAccess } from '@server/policy';
export async function handleRealtime(req:Request,path:string[]):Promise<Response|null>{
 if(req.method==='GET'&&path[0]==='boards'&&path[2]==='realtime-ticket'&&path.length===3){const principal=await requirePrincipal(req);await boardAccess(await getDb(),principal,path[1]);return json(setting('FREE_TIER_MODE')==='true'?await realtimeTicket(principal.id,path[1]):{mode:'sse'});}
 if(req.method!=='GET'||path[0]!=='boards'||path[2]!=='events'||path.length!==3)return null;
 if(setting('FREE_TIER_MODE')==='true')fail(410,'REALTIME_MOVED','실시간 연결을 다시 열어주세요.');
 const principal=await requirePrincipal(req);const db=await getDb();await boardAccess(db,principal,path[1]);let stopped=false;let timer:ReturnType<typeof setTimeout>|undefined;const encoder=new TextEncoder();
 let version=(await db.one<{version:string}>('SELECT COALESCE(MAX(id),0)::text AS version FROM outbox_events WHERE board_id=$1',[path[1]]))?.version||'0';
 const stream=new ReadableStream({start(controller){const stop=()=>{stopped=true;clearTimeout(timer);try{controller.close();}catch{}};req.signal.addEventListener('abort',stop,{once:true});controller.enqueue(encoder.encode(`retry: 2000\nevent: connected\ndata: {}\n\n`));async function check(){if(stopped)return;try{const fresh=await getPrincipal(req);if(!fresh)throw new Error('session revoked');await boardAccess(db,fresh,path[1]);const latest=(await db.one<{version:string}>('SELECT COALESCE(MAX(id),0)::text AS version FROM outbox_events WHERE board_id=$1',[path[1]]))?.version||'0';if(latest!==version){version=latest;controller.enqueue(encoder.encode(`id: ${version}\ndata: ${JSON.stringify({version})}\n\n`));}else controller.enqueue(encoder.encode(': heartbeat\n\n'));}catch{try{controller.enqueue(encoder.encode('event: revoked\ndata: {}\n\n'));}catch{}stop();return;}timer=setTimeout(check,1000);}timer=setTimeout(check,1000);},cancel(){stopped=true;clearTimeout(timer);}});
 return new Response(stream,{headers:{'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'}});
}
