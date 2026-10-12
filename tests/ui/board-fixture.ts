import type { BoardView } from '../../packages/contracts';

// Synthetic classroom data only; never copy a live school's posts into fixtures.
export const boardFixture: BoardView = {
  board: { id: 'preview-board', owner_id: 'teacher', title: '물리 변화와 화학 변화', description: '모둠별로 주변에서 발견한 변화를 나누고, 서로의 질문에 답해보세요.', format: 'columns', state: 'open', participation_mode: 'both', moderation: false, allow_comments: true, allow_reactions: true, anonymous_display: true, color: '#e2eafa', version: 1, deleted_at: null, created_at: '2026-10-12T00:00:00Z', updated_at: '2026-10-12T00:00:00Z' },
  principal: { id: 'teacher', role: 'teacher', display_name: '예시 교사' },
  can_manage: true, can_write: true, submission_only: false,
  sections: [1, 2, 3, 4].map(n => ({ id: `section-${n}`, board_id: 'preview-board', title: `${n}조`, rank: n * 100 })),
  posts: [
    { title: '얼음이 녹으면 어떤 변화일까요?', body: '모양과 상태가 달라져도 물이라는 물질은 그대로일까요?' },
    { title: '철이 녹슬었어요', body: '철의 색깔과 성질이 바뀌었어요. 어떤 변화인지 이유도 함께 적어봅시다.' },
    { title: '종이를 접었어요', body: '종이비행기를 만들었을 때 새로운 물질이 생겼을까요?' },
    { title: '우리 모둠의 질문', body: '주변에서 발견한 변화를 하나씩 모아보세요.' },
  ].map((content, n) => ({ ...content, id: `post-${n}`, board_id: 'preview-board', section_id: `section-${n + 1}`, link: null, status: 'published', color: '#ffffff', rank: 100, version: 1, created_at: '2026-10-12T00:00:00Z', updated_at: '2026-10-12T00:00:00Z', author_name: '예시 참여자', is_mine: false, can_edit: true, likes: n + 1, liked: false, comments: [], attachments: [] })),
};
