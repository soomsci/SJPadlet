import type { ExportedHandler } from '@cloudflare/workers-types';
import { Client } from 'pg';
import { wrap, type Database, type Engine } from '../../../packages/db/core';
import { dispatch } from '../../../packages/server/dispatch';
import { withRequestContext } from '../../../packages/server/common/runtime';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    const values: Record<string, string | undefined> = { NODE_ENV: 'production', ENABLE_DEMO_LOGIN: 'false' };
    for (const [key, value] of Object.entries(env)) if (typeof value === 'string') values[key] = value;
    // Production remains image-only, independent of dashboard variable edits.
    values.FREE_TIER_MODE = 'true';
    values.MEDIA_BACKEND = 'supabase';
    values.NODE_ENV = 'production';
    values.ENABLE_DEMO_LOGIN = 'false';
    let client: Client | undefined;
    let database: Promise<Database> | undefined;
    const connect = async (): Promise<Database> => {
      client = new Client({ connectionString: env.HYPERDRIVE.connectionString });
      await client.connect();
      const connection = client;
      return wrap(connection as Engine, async fn => {
        await connection.query('BEGIN');
        try {
          const tx = wrap(connection as Engine, async nested => nested(tx));
          const result = await fn(tx);
          await connection.query('COMMIT');
          return result;
        } catch (error) { await connection.query('ROLLBACK'); throw error; }
      });
    };
    try {
      const response = await withRequestContext({ values, database: () => database ??= connect() }, () => dispatch(request, url.pathname.slice(5).split('/')));
      const headers = new Headers(response.headers);
      headers.set('X-Content-Type-Options', 'nosniff');
      headers.set('Referrer-Policy', 'no-referrer');
      headers.set('X-Frame-Options', 'DENY');
      return new Response(response.body, { status: response.status, headers });
    } finally {
      if (client) ctx.waitUntil(client.end());
    }
  },
} satisfies ExportedHandler<Env>;
