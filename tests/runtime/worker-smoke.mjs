import worker from './worker.mjs';

export default {
  async test(ctrl, bindings, ctx) {
    const env = {
      APP_URL: 'https://example.com',
      FREE_TIER_MODE: 'false',
      MEDIA_BACKEND: 'local',
      ASSETS: { fetch: async () => new Response('static asset') },
      HYPERDRIVE: { get connectionString() { throw new Error('unexpected database access'); } },
    };
    const health = await worker.fetch(new Request('https://example.com/api/health'), env, ctx);
    if (health.status !== 200 || (await health.json()).data.status !== 'ok') throw new Error('health failed');
    if (health.headers.get('X-Content-Type-Options') !== 'nosniff') throw new Error('security header missing');
    const policy = await worker.fetch(new Request('https://example.com/api/upload-policy'), env, ctx);
    const body = (await policy.json()).data;
    if (!body.images_only || body.max_bytes !== 1024 * 1024) throw new Error('free upload policy not enforced');
    const assets = await worker.fetch(new Request('https://example.com/boards/test'), env, ctx);
    if (await assets.text() !== 'static asset') throw new Error('assets routing failed');
    const csrf = await worker.fetch(new Request('https://example.com/api/boards', {
      method: 'POST', headers: { Origin: 'https://evil.example' },
    }), env, ctx);
    if (csrf.status !== 403) throw new Error('cross-origin request accepted');
  },
};
