import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { parseCommandJson, readDeploymentValues, type FreeConfig } from './free-deployment-config';

const configPath = 'wrangler.jsonc';
const quietEnv = { ...process.env, WRANGLER_WRITE_LOGS: 'false', WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_SANITIZE: 'true' };
let stage = 'LOCAL_SETTINGS';
async function main() {
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as FreeConfig;
  const values = readDeploymentValues(config);
  if (process.argv.includes('--validate-only')) {
    console.log('로컬 설정 검증 통과. 비밀값을 출력하거나 외부에 전송하지 않았습니다.');
    return;
  }
  stage = 'CLOUDFLARE_LOGIN';
  const authResult = spawnSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'auth', 'token', '--json'], { encoding: 'utf8', env: quietEnv });
  if (authResult.status !== 0) throw new Error('일반 터미널에서 npm run cf:login을 먼저 완료해주세요.');
  // The token is captured in memory. Never print the command output.
  const auth = parseCommandJson(authResult.stdout) as { type: string; token?: string };
  if (!auth.token || !['oauth', 'api_token'].includes(auth.type)) throw new Error('Cloudflare OAuth/API token 로그인이 필요합니다.');
  const api = async <T>(path: string, method = 'GET', body?: unknown): Promise<T> => {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${config.account_id}${path}`, {
      method, headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000),
    });
    const data = await response.json() as { success: boolean; result: T; errors?: { code: number }[] };
    if (!response.ok || !data.success) throw new Error(`Cloudflare 연결 실패 (HTTP ${response.status}, 코드 ${data.errors?.[0]?.code ?? 'unknown'}). 비밀값은 출력하지 않았습니다.`);
    return data.result;
  };
  stage = 'CLOUDFLARE_ACCOUNT';
  const account = await api<{ id: string }>('');
  if (account.id !== config.account_id) throw new Error('Cloudflare 계정이 일치하지 않습니다.');
  stage = 'SUPABASE_SIGNING_KEY';
  const jwksResponse = await fetch(`${config.vars.SUPABASE_URL}/auth/v1/.well-known/jwks.json`, { signal: AbortSignal.timeout(15000) });
  const jwks = await jwksResponse.json() as { keys?: Record<string, string>[] };
  if (!jwksResponse.ok || !jwks.keys?.some(key => key.kid === values.key.kid && key.x === values.key.x && key.y === values.key.y && key.crv === 'P-256')) throw new Error('Supabase에서 가져온 서명 키를 활성화한 뒤 잠시 후 다시 실행해주세요.');
  stage = 'SUPABASE_STORAGE';
  const storageResponse = await fetch(`${config.vars.SUPABASE_URL}/storage/v1/bucket/classroom-images`, {
    headers: { apikey: values.secrets.SUPABASE_SECRET_KEY }, signal: AbortSignal.timeout(15000),
  });
  const bucket = await storageResponse.json() as { id?: string; public?: boolean; file_size_limit?: number };
  if (!storageResponse.ok || bucket.id !== 'classroom-images' || bucket.public !== false || bucket.file_size_limit !== 1048576) throw new Error('Supabase 서버 키와 비공개 이미지 버킷 설정을 확인해주세요.');
  console.log('계정, Supabase 서명 키 및 비공개 이미지 버킷 확인 완료.');
  interface Hyperdrive { id: string; name: string; caching: { disabled: boolean }; origin: { scheme: string; host: string; port: number; user: string; database: string } }
  stage = 'HYPERDRIVE';
  const currentId = config.hyperdrive[0]?.id;
  let database: Hyperdrive | undefined;
  if (currentId && !/^0+$/.test(currentId)) database = await api<Hyperdrive>(`/hyperdrive/configs/${currentId}`);
  else {
    const configs: Hyperdrive[] = [];
    for (let page = 1; ; page++) {
      const batch = await api<Hyperdrive[]>(`/hyperdrive/configs?per_page=100&page=${page}`);
      configs.push(...batch);
      if (batch.length < 100) break;
    }
    const matches = configs.filter(item => item.name === values.hyperdrive.name);
    if (matches.length > 1) throw new Error('같은 이름의 Hyperdrive가 여러 개입니다. 대상을 확인해주세요.');
    database = matches[0];
  }
  if (!database) {
    // No paid plan or subscription operation. Default TLS validates WebPKI certificates.
    database = await api<Hyperdrive>('/hyperdrive/configs', 'POST', values.hyperdrive);
    console.log('캐시가 비활성화된 Hyperdrive 생성 완료.');
  }
  const expected = values.hyperdrive.origin;
  if (!/^[a-f0-9]{32}$/.test(database.id) || database.caching.disabled !== true || !['postgres','postgresql'].includes(database.origin.scheme) || database.origin.host !== expected.host || database.origin.user !== expected.user || database.origin.port !== expected.port || database.origin.database !== expected.database) throw new Error('Hyperdrive 대상/캐시 설정이 일치하지 않습니다. 기존 리소스를 자동으로 수정하지 않습니다.');
  config.hyperdrive[0].id = database.id;
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  mkdirSync('.data', { recursive: true });
  const folder = mkdtempSync(join('.data', 'deploy-secrets-'));
  const secretsPath = join(folder, 'worker-secrets.json');
  try {
    writeFileSync(secretsPath, JSON.stringify(values.secrets), { mode: 0o600, flag: 'wx' });
    stage = 'CHECK_AND_DEPLOY';
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/deploy-free.mjs', '--secrets-file', secretsPath], { stdio: 'inherit', env: quietEnv });
    if (result.status !== 0) throw new Error('배포 검사가 중단됐습니다. 설정 파일은 유지되므로 원인을 해결한 뒤 재실행할 수 있습니다.');
  } finally { rmSync(folder, { recursive: true, force: true }); }
  stage = 'DEPLOYED_HEALTH';
  const health = await fetch(`${config.vars.APP_URL}/api/health`, { signal: AbortSignal.timeout(15000) });
  if (!health.ok || (await health.json()).data?.status !== 'ok') throw new Error('배포 후 상태 API를 확인하지 못했습니다.');
  stage = 'DEPLOYED_LOGIN_START';
  const login = await fetch(`${config.vars.APP_URL}/api/auth/google?intent=teacher&return_to=%2Fdashboard`, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
  const location = login.headers.get('location');
  if (login.status !== 302 || !location || new URL(location).hostname !== 'accounts.google.com') throw new Error('배포 후 DB를 사용하는 로그인 시작 API를 확인하지 못했습니다.');
  console.log(`배포 및 상태/로그인 시작 API 확인 완료: ${config.vars.APP_URL}`);
  console.log('학교 계정의 실제 로그인 완료, 학생 QR 및 실시간 수업 흐름은 브라우저에서 추가 확인해야 합니다.');
}
main().catch(error => {
  // Only our fixed messages may be logged; provider responses may include secrets.
  const known = error instanceof Error && /^(일반 터미널|Cloudflare |Supabase|같은 이름|Hyperdrive|배포 후|배포 검사)/.test(error.message);
  console.error(known ? error.message : '연결 또는 설정 확인에 실패했습니다. 비밀값을 출력하지 않고 중단합니다.');
  const causeCode = error?.cause?.code ?? error?.code;
  const code = ['ENOTFOUND','EAI_AGAIN','ECONNREFUSED','ETIMEDOUT','ECONNRESET'].includes(causeCode) ? causeCode : undefined;
  console.error(JSON.stringify({ stage, ...(code ? { network_code: code } : {}) }));
  process.exitCode = 1;
});
