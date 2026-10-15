import { expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { getDb, id, now, type Database } from '@db';
import { createAnonymousSession } from '@server/auth';
import { dispatch } from '@server/dispatch';

// Every query is a Worker → Hyperdrive → Supabase round trip (and counts toward the free daily query limit),
// so the classroom hot paths keep a query budget. Raise a ceiling only deliberately.
let sql: string[] = [];
const counting = (db: Database): Database => ({
  all: (s, p) => { sql.push(s); return db.all(s, p); }, one: (s, p) => { sql.push(s); return db.one(s, p); }, run: (s, p) => { sql.push(s); return db.run(s, p); },
  transaction: fn => { sql.push('BEGIN', 'COMMIT'); return db.transaction(tx => fn(counting(tx))); },
});
it('keeps board reads lock-free and classroom writes within their query budget', async () => {
  const real = await getDb(), global = globalThis as { samjeongDb?: Promise<Database> }, saved = global.samjeongDb;
  global.samjeongDb = Promise.resolve(counting(real));
  try {
    const teacher = id(), token = randomBytes(32).toString('base64url');
    await real.run("INSERT INTO principals(id,role,display_name,email,provider_subject,created_at) VALUES($1,'teacher','합성 교사',$2,$3,$4)", [teacher, `${teacher}@samjeong.ms.kr`, teacher, now()]);
    await real.run('INSERT INTO sessions(id,principal_id,token_hash,expires_at,created_at) VALUES($1,$2,$3,$4,$5)', [id(), teacher, createHash('sha256').update(token).digest('hex'), new Date(Date.now() + 3600000).toISOString(), now()]);
    const call = async (path: string, method = 'GET', body?: unknown, cookie = `samjeong_session=${token}`) => {
      sql = [];
      const response = await dispatch(new Request('http://localhost:3000/api/' + path, { method, headers: { cookie, origin: 'http://localhost:3000', 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }), path.split('/'));
      expect(response.status).toBeLessThan(300);
      return { data: (await response.json()).data, queries: sql.length, sql: [...sql] };
    };
    const { data: board } = await call('boards', 'POST', { title: '합성 수업', format: 'columns' }), boardId = board.board.id, sectionId = board.sections[0].id;
    await call(`boards/${boardId}`, 'PATCH', { version: board.board.version, state: 'open' });
    const { data: share } = await call('shares', 'POST', { board_id: boardId, target_type: 'board', target_id: boardId, scope: 'write', expires_hours: 2 });
    const student = (await createAnonymousSession('합성 학생')).cookie.split(';')[0];
    await call('join', 'POST', { token: share.url.split('/s/')[1], mode: 'anonymous', continue: true }, student);

    const read = await call(`boards/${boardId}`, 'GET', undefined, student);
    expect(read.sql.some(statement => /FOR UPDATE/i.test(statement))).toBe(false);
    expect(read.queries).toBeLessThanOrEqual(10);
    expect((await call(`boards/${boardId}/realtime-ticket`, 'GET', undefined, student)).queries).toBeLessThanOrEqual(5);
    const draftId = crypto.randomUUID();
    const { data: draft } = await call(`boards/${boardId}/drafts/${draftId}`, 'PUT', { version: 0, section_id: sectionId, title: '합성 글', body: '합성 본문' }, student);
    const created = await call(`boards/${boardId}/posts`, 'POST', { title: '합성 글', body: '합성 본문', section_id: sectionId, draft_id: draftId, draft_version: draft.version }, student);
    expect(created.queries).toBeLessThanOrEqual(24);
    // The write response is built inside the transaction; it must carry the bumped board version for the next edit.
    expect(created.data.view.board.version).toBe((await real.one<{ version: number }>('SELECT version FROM boards WHERE id=$1', [boardId]))!.version);
    const post = created.data.view.posts.find((item: { id: string }) => item.id === created.data.post_id);
    expect((await call(`posts/${post.id}`, 'PATCH', { version: post.version, body: '고친 합성 본문' }, student)).queries).toBeLessThanOrEqual(20);
  } finally { global.samjeongDb = saved; }
});
