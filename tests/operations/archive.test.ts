import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { runArchive } from '../../scripts/operations-backup';
import { contentTables, encryptBytes, openSnapshot } from '@server/operations/snapshot';

let temporary: string; const backupId = randomUUID(), attachmentId = randomUUID();
const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), snapshot = { version: 2, created_at: new Date().toISOString(), tables: Object.fromEntries(contentTables.map(table => [table, table === 'attachments' ? [{ id: attachmentId, bytes: image.length, storage_key: randomBytes(24).toString('hex'), mime: 'image/png', name: '학생 이름 없는 합성.png' }] : []])) };
const previous = ['BACKUP_ENCRYPTION_KEY', 'APP_URL', 'MOA_SESSION_COOKIE'].map(name => [name, process.env[name]] as const);
const fetchMock = vi.fn(async (request: string | URL | Request, init?: RequestInit) => { const url = new URL(String(request)); expect(url.origin).toBe('https://school.test'); expect(new Headers(init?.headers).get('cookie')).toBe('samjeong_session=synthetic'); if (url.pathname.endsWith('/download')) return new Response(new Uint8Array(encryptBytes(Buffer.from(JSON.stringify(snapshot))))); if (url.pathname.endsWith('/files/' + attachmentId)) return new Response(new Uint8Array(image)); throw new Error('Unexpected endpoint'); });
beforeAll(async () => { temporary = await mkdtemp(join(tmpdir(), 'moa-archive-test-')); process.env.BACKUP_ENCRYPTION_KEY = randomBytes(32).toString('base64url'); process.env.APP_URL = 'https://school.test'; process.env.MOA_SESSION_COOKIE = 'samjeong_session=synthetic'; vi.stubGlobal('fetch', fetchMock); vi.spyOn(console, 'log').mockImplementation(() => undefined); });
afterAll(async () => { await rm(temporary, { recursive: true, force: true }); for (const [name, value] of previous) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe('off-site image archive', () => {
  it('defaults to a read-only plan without writing files or downloading image bodies', async () => { const out = join(temporary, 'dry-run'); await runArchive(['export', '--backup', backupId, '--out', out]); expect(existsSync(out)).toBe(false); expect(fetchMock).toHaveBeenCalledTimes(1); });
  it('writes an authenticated encrypted database, image and manifest, then validates dry-run recovery without remote writes', async () => { const out = join(temporary, 'bundle'); await runArchive(['export', '--backup', backupId, '--out', out, '--apply']); const database = await readFile(join(out, 'database.sjbackup')); expect(openSnapshot(database).tables.attachments[0].id).toBe(attachmentId); const protectedImage = await readFile(join(out, 'files', attachmentId + '.sjfile')); expect(protectedImage.equals(image)).toBe(false); expect((await readFile(join(out, 'manifest.sjmanifest'))).toString()).not.toContain(attachmentId); fetchMock.mockClear(); await runArchive(['restore-files', '--dir', out]); expect(fetchMock).not.toHaveBeenCalled(); await expect(runArchive(['export', '--backup', backupId, '--out', out, '--apply'])).rejects.toThrow('이미 존재'); });
  it('rejects a changed image file before any storage write is attempted', async () => { const out = join(temporary, 'bundle'); const file = join(out, 'files', attachmentId + '.sjfile'), bytes = await readFile(file); bytes[bytes.length - 1] ^= 1; await writeFile(file, bytes); fetchMock.mockClear(); await expect(runArchive(['restore-files', '--dir', out, '--apply', '--confirm', '이미지 원본 복구'])).rejects.toThrow('체크섬'); expect(fetchMock).not.toHaveBeenCalled(); });
});
