import { z } from 'zod';
import type { AdminBoard, AdminBoardList } from '@contracts';
import type { Database } from '@db';
import { fail, json } from '@server/common/http';

const filters = z.object({
  q: z.string().trim().max(200).default(''),
  state: z.enum(['all','draft','open','closed','archived','trash']).default('all'),
  owner: z.string().max(200).default(''),
  cursor: z.string().max(512).nullable().default(null),
});

/** Called only after handleAdmin has authenticated an active school administrator. */
export async function listSchoolBoards(req: Request, db: Database): Promise<Response> {
  const parsed = filters.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) fail(400, 'INVALID_INPUT', '검색 조건을 확인해주세요.');
  const { q, state, owner, cursor } = parsed.data;
  // Treat search text literally, including SQL wildcard characters.
  const search = '%' + q.replace(/[\\%_]/g, '\\$&') + '%';
  const rows = await db.all<AdminBoard>(`SELECT b.id,b.owner_id,b.title,b.format,b.state,b.version,b.deleted_at,b.updated_at,
    p.display_name AS owner_name,p.email AS owner_email,p.disabled_at AS owner_disabled_at,
    (SELECT count(*)::int FROM posts x WHERE x.board_id=b.id AND x.status<>'deleted') AS post_count,
    (SELECT count(*)::int FROM posts x WHERE x.board_id=b.id AND x.status='pending') AS pending_count
    FROM boards b JOIN principals p ON p.id=b.owner_id
    WHERE (CASE WHEN $1='trash' THEN b.deleted_at IS NOT NULL ELSE b.deleted_at IS NULL END)
    AND ($1 IN ('all','trash') OR b.state=$1)
    AND ($2='' OR b.owner_id=$2)
    AND (b.title ILIKE $3 OR p.display_name ILIKE $3 OR p.email ILIKE $3)
    AND ($4::text IS NULL OR (b.updated_at || ':' || b.id)<$4)
    ORDER BY b.updated_at DESC,b.id DESC LIMIT 51`, [state, owner, search, cursor]);
  const boards = rows.slice(0, 50);
  return json({ boards, next_cursor: rows.length > 50 ? `${boards[49].updated_at}:${boards[49].id}` : null } satisfies AdminBoardList);
}
