import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';

const worker = (await import('../../apps/short-url/_worker.js' as string)).default as { fetch(request: Request): Response };
const config = JSON.parse(await readFile(new URL('../../wrangler.jsonc', import.meta.url), 'utf8')) as { vars: { APP_URL: string; SHARE_URL: string } };

describe('sjmoa.pages.dev short address', () => {
  it('forwards the same path and query to the school service without caching', () => {
    const response = worker.fetch(new Request('https://sjmoa.pages.dev/s/synthetic-token?x=1'));
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe(`${config.vars.APP_URL}/s/synthetic-token?x=1`);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
  it('cannot be turned into an open redirect and refuses API writes', () => {
    expect(new URL(worker.fetch(new Request('https://sjmoa.pages.dev//evil.example/path')).headers.get('Location')!).origin).toBe(config.vars.APP_URL);
    expect(worker.fetch(new Request('https://sjmoa.pages.dev/api/join', { method: 'POST' })).status).toBe(405);
  });
  it('is the host printed in share links', () => {
    expect(new URL(config.vars.SHARE_URL).host).toBe('sjmoa.pages.dev');
  });
});
