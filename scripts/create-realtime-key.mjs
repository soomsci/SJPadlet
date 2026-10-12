import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { generateKeyPair, exportJWK } from 'jose';
const pair = await generateKeyPair('ES256', { extractable: true });
const jwk = { ...await exportJWK(pair.privateKey), kid: randomUUID(), alg: 'ES256', use: 'sig' };
await mkdir('.data', { recursive: true });
await writeFile('.data/realtime-signing.jwk', JSON.stringify(jwk), { mode: 0o600, flag: 'wx' });
console.log('Created private key at .data/realtime-signing.jwk (git ignored). Import this key into Supabase; do not paste it into chat.');
