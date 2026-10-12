import { importJWK, SignJWT, type JWK } from 'jose';
import { setting } from '@server/common/runtime';
import { fail } from '@server/common/http';
export const TICKET_SECONDS = 60;
export async function realtimeTicket(principalId: string, boardId: string) {
  const url = setting('SUPABASE_URL'), key = setting('SUPABASE_PUBLISHABLE_KEY'), raw = setting('SUPABASE_SIGNING_JWK');
  if (!url || !key || !raw) fail(503, 'REALTIME_NOT_CONFIGURED', '실시간 연결 설정이 필요합니다.');
  let jwk: JWK;
  try { jwk = JSON.parse(raw); } catch { fail(503, 'REALTIME_NOT_CONFIGURED', '실시간 연결 설정을 확인해주세요.'); }
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.d || !jwk.kid) fail(503, 'REALTIME_NOT_CONFIGURED', '실시간 서명 키를 확인해주세요.');
  const topic = `moa:board:${boardId}`;
  const token = await new SignJWT({ role: 'authenticated', moa_capability: 'realtime-only', moa_topic: topic })
    .setProtectedHeader({ alg: 'ES256', kid: jwk.kid, typ: 'JWT' })
    .setSubject(principalId).setAudience('authenticated')
    .setIssuedAt().setExpirationTime(`${TICKET_SECONDS}s`)
    .sign(await importJWK(jwk, 'ES256'));
  return { mode: 'supabase' as const, url, key, topic, token, expires_in: TICKET_SECONDS };
}
