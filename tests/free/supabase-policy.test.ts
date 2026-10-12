import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
const db = new PGlite();
beforeAll(async () => {
  // Provider-owned schemas/functions are stubbed, while PostgreSQL runs the
  // actual generated application migration and enforces its grants and RLS.
  await db.exec(`
    CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;
    CREATE SCHEMA auth; CREATE SCHEMA realtime; CREATE SCHEMA storage;
    CREATE TABLE realtime.messages(topic text, extension text, payload jsonb);
    CREATE TABLE storage.buckets(id text PRIMARY KEY, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    CREATE TABLE storage.objects(id text PRIMARY KEY);
    CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT COALESCE(NULLIF(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
    CREATE FUNCTION realtime.topic() RETURNS text LANGUAGE sql STABLE AS $$ SELECT current_setting('realtime.topic',true) $$;
    CREATE FUNCTION realtime.send(payload jsonb,event text,topic text,private boolean) RETURNS void LANGUAGE sql AS $$ INSERT INTO realtime.messages VALUES(topic,'broadcast',payload) $$;
    GRANT USAGE ON SCHEMA auth TO authenticated;
    ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;
  `);
  await db.exec(await readFile(new URL('../../supabase/migrations/202610120001_free_hosting.sql', import.meta.url), 'utf8'));
});
afterAll(async () => { await db.close(); });
async function asClient(role: 'anon' | 'authenticated', fn: () => Promise<void>) {
  await db.exec('SET ROLE ' + role);
  try { await fn(); } finally { await db.exec('RESET ROLE'); }
}
describe('Supabase client access isolation', () => {
  it('does not allow direct application table reads or writes with browser roles', async () => {
    for (const role of ['anon','authenticated'] as const) await asClient(role, async () => {
      for (const table of ['principals','sessions','share_links','posts','attachments','outbox_events']) {
        await expect(db.query('SELECT * FROM public.' + table)).rejects.toThrow(/permission denied/);
        await expect(db.query('DELETE FROM public.' + table)).rejects.toThrow(/permission denied/);
      }
    });
  });
  it('creates a private image-only bucket with a server-enforced maximum', async () => {
    expect((await db.query<{public:boolean;file_size_limit:number;allowed_mime_types:string[]}>('SELECT * FROM storage.buckets')).rows[0]).toMatchObject({public:false,file_size_limit:1048576,allowed_mime_types:['image/jpeg','image/png','image/webp']});
    expect((await db.query("SELECT * FROM pg_policies WHERE schemaname='storage' AND tablename='objects'")).rows).toHaveLength(0);
  });
  it('publishes only empty invalidation messages and restricts subscriptions to the signed topic', async () => {
    await db.query("INSERT INTO outbox_events(board_id,event_type,created_at) VALUES('board-a','changed','2026-10-12')");
    await db.query("INSERT INTO outbox_events(board_id,event_type,created_at) VALUES('board-b','changed','2026-10-12')");
    expect((await db.query('SELECT payload FROM realtime.messages')).rows).toEqual([{payload:{}},{payload:{}}]);
    await db.query("SELECT set_config('realtime.topic','moa:board:board-a',false)");
    await db.query("SELECT set_config('request.jwt.claims',$1,false)", [JSON.stringify({moa_capability:'realtime-only',moa_topic:'moa:board:board-a'})]);
    await asClient('authenticated', async () => {
      expect((await db.query('SELECT topic,payload FROM realtime.messages')).rows).toEqual([{topic:'moa:board:board-a',payload:{}}]);
      await expect(db.query("INSERT INTO realtime.messages VALUES('moa:board:board-a','broadcast','{}')")).rejects.toThrow(/permission denied/);
    });
    await db.query("SELECT set_config('realtime.topic','moa:board:board-b',false)");
    await asClient('authenticated', async () => { expect((await db.query('SELECT * FROM realtime.messages')).rows).toHaveLength(0); });
    await db.query("SELECT set_config('request.jwt.claims','{}',false)");
    await asClient('authenticated', async () => { expect((await db.query('SELECT * FROM realtime.messages')).rows).toHaveLength(0); });
  });
});
