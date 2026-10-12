import { dispatch } from '@server/dispatch';
export const runtime='nodejs';
export const dynamic='force-dynamic';
async function route(req:Request,{params}:{params:Promise<{path:string[]}>}){return dispatch(req,(await params).path);}
export {route as GET,route as POST,route as PATCH,route as DELETE,route as PUT};
