import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { createHash } from 'node:crypto';
import { Client } from 'pg';
if (existsSync('.env.free')) loadEnvFile('.env.free');
if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL in ignored .env.free. Use the dedicated Supabase project.');
const folder = new URL('../supabase/migrations/', import.meta.url);
const migrations = (await readdir(folder)).filter(name => /^\d{12,14}_[a-z0-9_]+\.sql$/.test(name)).sort();
const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(8242026)');
  await client.query('CREATE TABLE IF NOT EXISTS public.moa_migrations(version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
  await client.query('ALTER TABLE public.moa_migrations ENABLE ROW LEVEL SECURITY');
  await client.query('REVOKE ALL ON public.moa_migrations FROM anon,authenticated');
  for (const file of migrations) {
    const migration = file.slice(0, -4), sql = await readFile(new URL(file, folder), 'utf8');
    const digest = createHash('sha256').update(sql).digest('hex');
    const prior = await client.query('SELECT checksum FROM public.moa_migrations WHERE version=$1', [migration]);
    if (prior.rowCount) {
      if (prior.rows[0].checksum !== digest) throw new Error('Applied migration changed. Add a new version instead.');
      console.log(`Migration already applied: ${migration}`);
    } else {
      await client.query(sql);
      await client.query('INSERT INTO public.moa_migrations(version,checksum) VALUES($1,$2)', [migration, digest]);
      console.log(`Migration applied: ${migration}`);
    }
  }
  await client.query('COMMIT');
} catch (error) {
  await client.query('ROLLBACK'); throw error;
} finally { await client.end(); }
