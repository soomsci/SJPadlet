import { importPKCS8, SignJWT } from 'jose';
import { setting } from '@server/common/runtime';

const scope = 'https://www.googleapis.com/auth/admin.directory.group.member.readonly';
const timeout = () => AbortSignal.timeout(5000);

/** Google Workspace group whose members are teachers; empty when the feature is off. */
export const teacherGroup = () => (setting('TEACHER_GROUP_EMAIL') || '').trim().toLowerCase();

/**
 * Asks the Admin SDK whether `email` is a (nested) member of the teacher group.
 * Uses a service account key (GOOGLE_DIRECTORY_KEY) with domain-wide delegation impersonating
 * GOOGLE_DIRECTORY_SUBJECT. Throws on any configuration or Google failure; callers decide how to fail.
 * Provider response bodies are never included in errors because they may echo credentials.
 */
export async function inTeacherGroup(email: string): Promise<boolean> {
  const group = teacherGroup();
  let key: { client_email?: string; private_key?: string };
  try { key = JSON.parse(setting('GOOGLE_DIRECTORY_KEY') || '{}'); } catch { throw new Error('Directory key is not valid JSON'); }
  if (!group || !key.client_email || !key.private_key) throw new Error('Teacher group lookup is not configured');
  const jwt = new SignJWT({ scope }).setProtectedHeader({ alg: 'RS256' }).setIssuer(key.client_email)
    .setAudience('https://oauth2.googleapis.com/token').setIssuedAt().setExpirationTime('5m');
  const subject = setting('GOOGLE_DIRECTORY_SUBJECT');
  if (subject) jwt.setSubject(subject);
  const assertion = await jwt.sign(await importPKCS8(key.private_key, 'RS256'));
  const token = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', signal: timeout(), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }) });
  if (!token.ok) throw new Error(`Directory token request failed (${token.status})`);
  const { access_token: accessToken } = await token.json() as { access_token?: string };
  if (!accessToken) throw new Error('Directory token missing');
  const result = await fetch(`https://admin.googleapis.com/admin/directory/v1/groups/${encodeURIComponent(group)}/hasMember/${encodeURIComponent(email)}`, { signal: timeout(), headers: { Authorization: `Bearer ${accessToken}` } });
  if (!result.ok) throw new Error(`Directory membership check failed (${result.status})`);
  return (await result.json() as { isMember?: boolean }).isMember === true;
}
