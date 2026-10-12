import { PGlite } from '@electric-sql/pglite';
import { Pool, type PoolClient } from 'pg';
import { mkdir } from 'node:fs/promises';
import { schema } from './schema';
import { dataPath } from '../server/common/config';
import { wrap, type Database, type Engine } from './core';
export type { Database } from './core';
export { id, now, emit, audit } from './helpers';
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
