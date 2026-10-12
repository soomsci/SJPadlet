import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

export interface FreeConfig {
  account_id: string;
  name: string;
  vars: Record<string, string>;
  hyperdrive: { binding: string; id: string }[];
  secrets: { required: string[] };
}
export function parseCommandJson(output: string): unknown {
  for (let index = 0; index < output.length; index++) {
    if (!['{', '['].includes(output[index])) continue;
    try { return JSON.parse(output.slice(index).trim()); } catch { /* Try the next JSON boundary. */ }
  }
  throw new Error('명령 결과를 확인하지 못했습니다. 비밀값을 출력하지 않고 중단합니다.');
}
export function deploymentValues(config: FreeConfig, env: Record<string, string | undefined>, rawKey: string) {
  if (!/^[a-f0-9]{32}$/.test(config.account_id) || !/^[a-z0-9-]+$/.test(config.name)) throw new Error('Cloudflare 대상 계정과 Worker 이름을 확인해주세요.');
  if (config.vars.FREE_TIER_MODE !== 'true' || config.vars.MEDIA_BACKEND !== 'supabase') throw new Error('무료 이미지 모드가 필요합니다.');
  const supabase = new URL(config.vars.SUPABASE_URL);
  const ref = supabase.hostname.match(/^([a-z0-9]+)\.supabase\.co$/)?.[1];
  if (!ref || supabase.protocol !== 'https:' || env.SUPABASE_URL !== supabase.origin) throw new Error('Supabase 프로젝트 주소가 일치하지 않습니다.');
  const db = new URL(env.DATABASE_URL || '');
  const username = decodeURIComponent(db.username), password = decodeURIComponent(db.password);
  const session = db.hostname.endsWith('.pooler.supabase.com') && username === `postgres.${ref}` && db.port === '5432';
  const direct = db.hostname === `db.${ref}.supabase.co` && username === 'postgres';
  if (!['postgres:', 'postgresql:'].includes(db.protocol) || (!session && !direct) || db.pathname !== '/postgres' || !password || /YOUR-PASSWORD|여기에_DB/.test(password)) {
    throw new Error('이 프로젝트의 DB 접속 주소와 실제 비밀번호가 필요합니다.');
  }
  if (!env.GOOGLE_CLIENT_ID?.endsWith('.apps.googleusercontent.com') || !env.GOOGLE_CLIENT_SECRET || !env.SUPABASE_SECRET_KEY?.startsWith('sb_secret_')) throw new Error('Google 및 Supabase 서버 비밀값을 확인해주세요.');
  const key = JSON.parse(rawKey) as Record<string, string>;
  if (key.kty !== 'EC' || key.crv !== 'P-256' || !key.d || !key.x || !key.y || !key.kid) throw new Error('ES256 서명 키를 확인해주세요.');
  const secrets = {
    GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: env.GOOGLE_CLIENT_SECRET,
    SUPABASE_SECRET_KEY: env.SUPABASE_SECRET_KEY,
    SUPABASE_SIGNING_JWK: JSON.stringify(key),
  };
  return {
    key, secrets,
    hyperdrive: {
      name: `${config.name}-db`, caching: { disabled: true }, origin_connection_limit: 5,
      origin: { scheme: 'postgresql', host: db.hostname, port: Number(db.port || 5432), user: username, password, database: 'postgres' },
    },
  };
}
export function readDeploymentValues(config: FreeConfig) {
  const env = parseEnv(readFileSync('.env.free', 'utf8'));
  // The same imported key is used, with no repeated copy into .env.free.
  return deploymentValues(config, env, readFileSync('.data/realtime-signing.jwk', 'utf8'));
}
