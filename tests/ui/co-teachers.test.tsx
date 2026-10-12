// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { BoardMembers } from '@contracts';
import { BoardWorkspace, Dashboard } from '../../apps/web/src/features/boards';
import { MembersPanel } from '../../apps/web/src/features/boards/members';
import { boardFixture } from './board-fixture';

vi.mock('@features/live', () => ({ watchBoard: () => () => undefined }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const members = (edit: boolean): BoardMembers => ({ owner: { id: 'teacher', display_name: '소유 교사', email: 'owner@samjeong.ms.kr' }, members: [{ principal_id: 'co', display_name: '공동 교사', email: 'co@samjeong.ms.kr', role: 'editor' }], invites: [{ email: 'new@samjeong.ms.kr', role: 'reader', created_at: '2026-10-12T00:00:00Z' }], can_edit_members: edit });
function stub(data: (path: string, init?: RequestInit) => unknown) {
  const mock = vi.fn(async (path: string, init?: RequestInit) => new Response(JSON.stringify({ data: data(path, init) })));
  vi.stubGlobal('fetch', mock); return mock;
}
const sent = (mock: ReturnType<typeof stub>, method: string) => mock.mock.calls.filter(([, init]) => init?.method === method).map(([, init]) => JSON.parse(String(init!.body)));

it('lets the owner add, re-role and remove co-teachers and pending invites', async () => {
  const mock = stub(() => members(true));
  render(<MembersPanel view={boardFixture} />);
  const idle = () => waitFor(() => expect((screen.getByRole('button', { name: '공동 교사 선생님 내보내기' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.change(await screen.findByRole('combobox', { name: '공동 교사 권한' }), { target: { value: 'reader' } }); await idle();
  fireEvent.click(screen.getByRole('button', { name: '공동 교사 선생님 내보내기' })); await idle();
  fireEvent.click(screen.getByRole('button', { name: 'new@samjeong.ms.kr 초대 취소' })); await idle();
  fireEvent.change(screen.getByRole('textbox', { name: '선생님 학교 이메일' }), { target: { value: 'third@samjeong.ms.kr' } });
  fireEvent.click(screen.getByRole('button', { name: '추가' }));
  await waitFor(() => expect(sent(mock, 'POST')).toEqual([{ email: 'co@samjeong.ms.kr', role: 'reader' }, { email: 'third@samjeong.ms.kr', role: 'editor' }]));
  expect(sent(mock, 'DELETE')).toEqual([{ principal_id: 'co' }, { email: 'new@samjeong.ms.kr' }]);
  expect(screen.getByText('첫 로그인 대기 중')).toBeTruthy();
});

it('shows editors a read-only list with a leave option instead of invite controls', async () => {
  stub(() => members(false));
  render(<MembersPanel view={{ ...boardFixture, principal: { id: 'co', role: 'teacher', display_name: '공동 교사' } }} />);
  expect(await screen.findByRole('button', { name: '이 게시판에서 나가기' })).toBeTruthy();
  expect(screen.queryByRole('textbox', { name: '선생님 학교 이메일' })).toBeNull();
  expect(screen.queryByRole('combobox', { name: '공동 교사 권한' })).toBeNull();
});

it('shows teacher actions with the acting teacher in the activity panel only for managers', async () => {
  const mock = stub(path => path.endsWith('/activity') ? [{ id: 'a1', action: 'section.rename', target_id: 'section-2', actor_name: '공동 교사', created_at: '2026-10-12T23:00:00Z' }] : path.endsWith('/drafts') ? [] : boardFixture);
  render(<BoardWorkspace boardId="preview-board" />);
  fireEvent.click(await screen.findByRole('button', { name: '최근 활동' }));
  const action = await within(screen.getByRole('dialog', { name: '최근 활동' })).findByText('공동 교사 선생님이 섹션 이름을 바꿨어요');
  expect(action.closest('li')!.textContent).toContain('2조');
  expect(within(screen.getByRole('dialog', { name: '최근 활동' })).getAllByRole('listitem')[0]).toBe(action.closest('li'));
  cleanup(); mock.mockClear();
  stub(path => path.endsWith('/drafts') ? [] : { ...boardFixture, can_manage: false, principal: { id: 's', role: 'student', display_name: '학생' } });
  render(<BoardWorkspace boardId="preview-board" />);
  fireEvent.click(await screen.findByRole('button', { name: '최근 활동' }));
  expect((fetch as unknown as ReturnType<typeof stub>).mock.calls.some(([path]) => String(path).endsWith('/activity'))).toBe(false);
});

it('filters boards shared with me and labels the role and owner', async () => {
  const mock = stub(() => ({ boards: [{ ...boardFixture.board, favorite: false, post_count: 2, my_role: 'editor', owner_name: '소유 교사' }], next_cursor: null }));
  render(<Dashboard />);
  fireEvent.click(await screen.findByRole('button', { name: '공유받은 게시판' }));
  await waitFor(() => expect(mock.mock.calls.some(([path]) => String(path).includes('shared=true'))).toBe(true));
  expect(await screen.findByText(/공동 편집 · 소유 교사/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: `${boardFixture.board.title} 휴지통으로 이동` })).toBeNull();
});
