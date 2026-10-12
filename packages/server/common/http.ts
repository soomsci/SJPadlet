import { randomUUID } from 'node:crypto';
import { z } from 'zod';
export class ApiError extends Error { constructor(public status:number,public code:string,message:string){super(message);} }
export function fail(status:number,code:string,message:string):never {throw new ApiError(status,code,message);}
export function json<T>(data:T,status=200,headers?:HeadersInit){return Response.json({data},{status,headers:{'Cache-Control':'no-store',...headers}});}
export async function input<T>(req:Request,schema:z.ZodType<T>):Promise<T>{let body;try{body=await req.json();}catch{fail(400,'INVALID_INPUT','올바른 요청이 아닙니다.');}const result=schema.safeParse(body);if(!result.success)fail(400,'INVALID_INPUT',result.error.issues[0]?.message??'입력을 확인해주세요.');return result.data;}
export function errorResponse(error:unknown){if(error instanceof ApiError)return Response.json({error:{code:error.code,message:error.message,requestId:randomUUID()}},{status:error.status});console.error('request failed',error instanceof Error?error.message:'unknown');return Response.json({error:{code:'INTERNAL_ERROR',message:'요청을 처리하지 못했습니다.',requestId:randomUUID()}},{status:500});}
export function assertSameOrigin(req:Request){if(['GET','HEAD','OPTIONS'].includes(req.method))return;const origin=req.headers.get('origin');const expected=new URL(process.env.APP_URL||'http://localhost:3000').origin;if(origin!==expected)fail(403,'FORBIDDEN','다시 페이지를 열고 시도해주세요.');if(req.headers.get('sec-fetch-site')==='cross-site')fail(403,'FORBIDDEN','허용되지 않은 요청입니다.');}
export function cookieValue(req:Request,name:string){const pair=(req.headers.get('cookie')||'').split(';').map(s=>s.trim()).find(s=>s.startsWith(name+'='));return pair?decodeURIComponent(pair.slice(name.length+1)):null;}
