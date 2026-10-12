import { describe, expect, it } from 'vitest';
import { deploymentValues, parseCommandJson, type FreeConfig } from '../../scripts/free-deployment-config';
const config: FreeConfig = {
  account_id: 'a'.repeat(32), name: 'moa',
  vars: { FREE_TIER_MODE: 'true', MEDIA_BACKEND: 'supabase', SUPABASE_URL: 'https://projecta.supabase.co' },
  hyperdrive: [{ binding: 'HYPERDRIVE', id: '0'.repeat(32) }], secrets: { required: [] },
};
const env = {
  SUPABASE_URL: config.vars.SUPABASE_URL,
  DATABASE_URL: 'postgresql://postgres.projecta:fake%40password@aws-0-ap-northeast-2.pooler.supabase.com:5432/postgres',
  GOOGLE_CLIENT_ID: 'test.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'fake-google-secret', SUPABASE_SECRET_KEY: 'sb_secret_fake',
  UNRELATED_SECRET: 'never-upload-this',
};
const key = JSON.stringify({ kty: 'EC', crv: 'P-256', kid: 'fake-key-id', d: 'fake-private', x: 'fake-x', y: 'fake-y' });
describe('deployment secrets and database target', () => {
  it('passes only the four Worker secrets and decodes DB passwords separately', () => {
    const result = deploymentValues(config, env, key);
    expect(Object.keys(result.secrets).sort()).toEqual(['GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET','SUPABASE_SECRET_KEY','SUPABASE_SIGNING_JWK']);
    expect(result.hyperdrive.origin.password).toBe('fake@password');
    expect(result.hyperdrive).toMatchObject({ caching: { disabled: true }, origin_connection_limit: 5 });
    expect(JSON.stringify(result.secrets)).not.toContain('fake@password');
    expect(JSON.stringify(result.secrets)).not.toContain('never-upload-this');
  });
  it('rejects a different project or unexpected DB host before sending credentials', () => {
    expect(() => deploymentValues(config, { ...env, DATABASE_URL: env.DATABASE_URL.replace('postgres.projecta:', 'postgres.projectb:') }, key)).toThrow();
    expect(() => deploymentValues(config, { ...env, DATABASE_URL: env.DATABASE_URL.replace('aws-0-ap-northeast-2.pooler.supabase.com', 'evil.example') }, key)).toThrow();
  });
  it('rejects placeholders, publishable keys in secret fields and public-only signing keys', () => {
    expect(() => deploymentValues(config, { ...env, DATABASE_URL: env.DATABASE_URL.replace('fake%40password', 'YOUR-PASSWORD') }, key)).toThrow();
    expect(() => deploymentValues(config, { ...env, SUPABASE_SECRET_KEY: 'sb_publishable_fake' }, key)).toThrow();
    expect(() => deploymentValues(config, env, JSON.stringify({ kty: 'EC', crv: 'P-256', x: 'x', y: 'y', kid: 'id' }))).toThrow();
  });
  it('reads structured Wrangler output without including raw output in errors', () => {
    expect(parseCommandJson('Wrangler [notice]\n{"type":"oauth","token":"fake"}\n')).toEqual({ type:'oauth', token:'fake' });
    expect(parseCommandJson('\u001b[90mWrangler\u001b[0m\n{"caching":{"disabled":true}}\n')).toEqual({ caching: { disabled:true } });
    expect(() => parseCommandJson('sensitive-invalid-output')).toThrow('명령 결과를 확인하지 못했습니다.');
  });
});

describe('static security headers', () => {
  it('pins the CSP Supabase origin to the deployed project instead of any *.supabase.co', async () => {
    const { readFile } = await import('node:fs/promises');
    const headers = await readFile(new URL('../../apps/free-web/public/_headers', import.meta.url), 'utf8');
    const deployed = JSON.parse(await readFile(new URL('../../wrangler.jsonc', import.meta.url), 'utf8')) as { vars: { SUPABASE_URL: string } };
    const connect = headers.match(/connect-src ([^;]+)/)![1].split(/\s+/);
    const host = new URL(deployed.vars.SUPABASE_URL).host;
    expect(connect).toEqual(["'self'", `https://${host}`, `wss://${host}`]);
  });
});
