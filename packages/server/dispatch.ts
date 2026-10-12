import { handleDrafts } from '@server/drafts';
import { handleAuth } from '@server/auth';
import { handleBoards } from '@server/boards';
import { handleShares } from '@server/shares';
import { handleMedia } from '@server/media';
import { handleRealtime } from '@server/realtime';
import { handleAdmin } from '@server/admin';
import { handleOperations } from '@server/operations';
import { handleExports } from '@server/exports';
import { handleParticipants } from '@server/participants';
import { assertSameOrigin, errorResponse, fail, json } from '@server/common/http';
import { uploadPolicy } from '@server/media/policy';

export async function dispatch(req: Request, path: string[]): Promise<Response> {
  try {
    assertSameOrigin(req);
    if (req.method === 'GET' && path.length === 1 && path[0] === 'health') return json({ status: 'ok' });
    if (req.method === 'GET' && path.length === 1 && path[0] === 'upload-policy') {
      const policy = uploadPolicy();
      return json({ images_only: policy.imagesOnly, max_bytes: policy.maxBytes });
    }
    for (const handler of [handleAuth, handleShares, handleMedia, handleRealtime, handleExports, handleOperations, handleAdmin, handleParticipants, handleDrafts, handleBoards]) {
      const response = await handler(req, path);
      if (response) return response;
    }
    fail(404, 'NOT_FOUND', '페이지를 찾을 수 없습니다.');
  } catch (error) { return errorResponse(error); }
}
