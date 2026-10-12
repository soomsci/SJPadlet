import { PGlite } from '@electric-sql/pglite';
import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { schema } from './schema';
import { dataPath } from '../server/common/config';
export interface Database {
 all<T = Record<string,unknown>>(sql:string,params?:unknown[]):Promise<T[]>;
 one<T = Record<string,unknown>>(sql:string,params?:unknown[]):Promise<T|null>;
 run(sql:string,params?:unknown[]):Promise<void>;
 transaction<T>(fn:(tx:Database)=>Promise<T>):Promise<T>;
}
type Engine={query:<T>(sql:string,params?:unknown[])=>Promise<{rows:T[]}>};
function wrap(engine:Engine,transaction:<T>(fn:(tx:Database)=>Promise<T>)=>Promise<T>):Database{return {async all<T>(s:string,p:unknown[]=[]){return (await engine.query<T>(s,p)).rows;},async one<T>(s:string,p:unknown[]=[]){return (await engine.query<T>(s,p)).rows[0]??null;},async run(s,p=[]){await engine.query(s,p);},transaction};}
async function createDatabase():Promise<Database>{
 if(process.env.DATABASE_URL){
  const pool=new Pool({connectionString:process.env.DATABASE_URL,max:10});
  await pool.query(schema);
  const transaction=async<T>(fn:(tx:Database)=>Promise<T>)=>{const client:PoolClient=await pool.connect();try{await client.query('BEGIN');const tx=wrap(client as Engine,async g=>g(tx));const value=await fn(tx);await client.query('COMMIT');return value;}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}};
  return wrap(pool as Engine,transaction);
 }
 if(process.env.NODE_ENV==='production')throw new Error('Production requires DATABASE_URL.');
 const location=process.env.DATABASE_PATH||'.data/postgres';
 if(location!=='memory://')await mkdir(dataPath(location),{recursive:true});
 const engine=new PGlite(location==='memory://'?undefined:dataPath(location));await engine.exec(schema);
 return wrap(engine as Engine,async fn=>engine.transaction(async raw=>{const tx=wrap(raw as Engine,async g=>g(tx));return fn(tx);}));
}
const globalDb=globalThis as typeof globalThis & {samjeongDb?:Promise<Database>};
export function getDb(){return globalDb.samjeongDb??=createDatabase();}
export const id=()=>randomUUID();export const now=()=>new Date().toISOString();
export async function emit(tx:Database,boardId:string,type='changed'){await tx.run('INSERT INTO outbox_events(board_id,event_type,created_at) VALUES($1,$2,$3)',[boardId,type,now()]);}
export async function audit(tx:Database,actor:string,action:string,target:string){await tx.run('INSERT INTO audit_events(id,actor_id,action,target_id,created_at) VALUES($1,$2,$3,$4,$5)',[id(),actor,action,target,now()]);}
