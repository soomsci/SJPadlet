import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { parseCommandJson } from './free-deployment-config.ts';
const config = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
const secretsFlag = process.argv.indexOf('--secrets-file');
const secretsPath = secretsFlag >= 0 ? process.argv[secretsFlag + 1] : undefined;
const problems = [];
if (!config.account_id) problems.push('Cloudflare account_id');
if (!config.hyperdrive?.[0]?.id || /^0+$/.test(config.hyperdrive[0].id)) problems.push('Hyperdrive ID');
for (const key of ['APP_URL','SUPABASE_URL','SUPABASE_PUBLISHABLE_KEY','TEACHER_EMAILS','ADMIN_EMAILS']) {
  if (!config.vars[key] || /YOUR_/.test(config.vars[key])) problems.push(key);
}
if (config.vars.FREE_TIER_MODE !== 'true' || config.vars.MEDIA_BACKEND !== 'supabase') problems.push('free hosting mode');
if (problems.length) {
  console.error('배포 전 설정이 필요합니다: ' + problems.join(', '));
  console.error('docs/DEPLOY_FREE.md를 확인해주세요. 비밀값은 채팅이나 wrangler.jsonc에 넣지 마세요.');
  process.exit(1);
}
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
function run(args) {
  const result = spawnSync(npm, args, { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
run(['run','check:free']);
// Capture configuration/secret metadata rather than printing connection details.
function inspect(args) {
  const result = spawnSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', ...args], {
    encoding: 'utf8', env: { ...process.env, WRANGLER_WRITE_LOGS: 'false', WRANGLER_LOG: 'log', WRANGLER_LOG_SANITIZE: 'true', WRANGLER_SEND_METRICS: 'false' },
  });
  if (result.status !== 0) throw new Error('Cloudflare 설정을 확인하지 못했습니다. 계정 로그인과 권한을 확인해주세요.');
  return parseCommandJson(result.stdout);
}
const database = inspect(['hyperdrive','get',config.hyperdrive[0].id]);
if (database.id !== config.hyperdrive[0].id || database.caching?.disabled !== true) {
  throw new Error('Hyperdrive 쿼리 캐시를 비활성화해야 합니다. 권한 회수 후 오래된 정보가 반환될 수 있습니다.');
}
if (secretsPath) {
  const secrets = JSON.parse(readFileSync(secretsPath, 'utf8'));
  if (!config.secrets.required.every(name => typeof secrets[name] === 'string' && secrets[name])) throw new Error('필수 Worker secret 설정이 누락되었습니다.');
} else {
  const secrets = inspect(['secret','list']);
  if (!config.secrets.required.every(name => secrets.some(secret => secret.name === name))) throw new Error('필수 Worker secret 설정이 누락되었습니다.');
}
run(['exec','--','wrangler','deploy', ...(secretsPath ? ['--secrets-file', secretsPath] : [])]);
