// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { BoardWorkspace, Dashboard } from '../../apps/web/src/features/boards';
import { boardFixture } from './board-fixture';

vi.mock('@features/live', () => ({ watchBoard: () => () => undefined }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path.endsWith('/sections/section-1') && init?.method === 'PATCH') {
      const { title } = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ data: { ...boardFixture, sections: boardFixture.sections.map(s => s.id === 'section-1' ? { ...s, title } : s) } }));
    }
    if (path.endsWith('/drafts')) return new Response(JSON.stringify({ data: [] }));
    return new Response(JSON.stringify({ data: path === '/api/upload-policy' ? { images_only: true, max_bytes: 1048576 } : boardFixture }));
  }));
});

it('renames a section through the real workspace without losing input focus', async () => {
  render(<BoardWorkspace boardId="preview-board" />);
  fireEvent.click(await screen.findByRole('button', { name: '1조' }));
  const input = screen.getByRole('textbox', { name: '섹션 이름' }) as HTMLInputElement;
  fireEvent.change(input, { target: { value: '탐구 모둠' } });
  expect(document.activeElement).toBe(input);
  fireEvent.submit(input.closest('form')!);
  await screen.findByRole('button', { name: '탐구 모둠' });
  expect(screen.queryByRole('dialog', { name: '섹션 이름 수정' })).toBeNull();
  expect(fetch).toHaveBeenCalledWith('/api/boards/preview-board/sections/section-1', expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ title: '탐구 모둠' }) }));
});

it('adds a post to the selected column and keeps comments available on the card', async () => {
  render(<BoardWorkspace boardId="preview-board" />);
  const heading = await screen.findByRole('heading', { name: '2조 1' });
  const section = heading.closest('section')!;
  const add = within(section).getByRole('button', { name: '게시물 추가' });
  const card = section.querySelector('article')!;
  expect(add.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(within(card).getByRole('textbox', { name: '댓글 내용' })).toBeTruthy();
  fireEvent.click(add);
  const dialog = screen.getByRole('dialog', { name: '새로운 생각 남기기' });
  const select = within(dialog).getByRole('combobox', { name: '섹션' }) as HTMLSelectElement;
  expect(select.value).toBe('section-2');
  await waitFor(() => expect(within(dialog).getByRole('button', { name: '생각 올리기' }).hasAttribute('disabled')).toBe(false));
});

it('keeps school administration available only to the administrator in the board account menu', async () => {
  const adminView = { ...boardFixture, principal: { ...boardFixture.principal, role: 'admin' } };
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: adminView }))));
  const { unmount } = render(<BoardWorkspace boardId="preview-board" />);
  await screen.findByRole('navigation', { name: '게시판 도구' });
  const account = screen.getByText('예', { selector: 'summary' }).closest('details')!;
  account.setAttribute('open', '');
  expect(within(account).getByRole('link', { name: '학교 관리' }).getAttribute('href')).toBe('/admin');
  unmount();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: boardFixture }))));
  render(<BoardWorkspace boardId="preview-board" />);
  await screen.findByRole('navigation', { name: '게시판 도구' });
  expect(screen.queryByText('학교 관리')).toBeNull();
});

it('does not show teacher tools or posting controls to a student in a closed board', async () => {
  const studentView = { ...boardFixture, board: { ...boardFixture.board, state: 'closed' }, principal: { id: 'student', role: 'student', display_name: '예시 학생' }, can_manage: false, can_write: false, posts: [] };
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: studentView }))));
  render(<BoardWorkspace boardId="preview-board" />);
  await screen.findByRole('heading', { name: boardFixture.board.title });
  expect(screen.queryByRole('button', { name: '새 생각 올리기' })).toBeNull();
  expect(screen.queryByRole('button', { name: '게시물 추가' })).toBeNull();
  expect(screen.queryByRole('button', { name: '게시판 설정' })).toBeNull();
  expect(screen.queryByRole('button', { name: '참여 관리' })).toBeNull();
  expect(screen.queryByText('학교 관리')).toBeNull();
});

it('keeps library filters and board creation working in the compact dashboard', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: { boards: [{ ...boardFixture.board, favorite: true, post_count: 4 }], next_cursor: null } }))));
  render(<Dashboard />);
  await screen.findByRole('link', { name: boardFixture.board.title });
  fireEvent.click(screen.getByRole('button', { name: '즐겨찾기' }));
  await screen.findByRole('heading', { name: '즐겨찾기 1' });
  fireEvent.click(screen.getByRole('button', { name: '만들기' }));
  const dialog = screen.getByRole('dialog', { name: '새로운 수업 공간 만들기' });
  const input = within(dialog).getByRole('textbox', { name: '게시판 이름' });
  fireEvent.change(input, { target: { value: '새 수업' } });
  expect(document.activeElement).toBe(input);
});

it('deletes a section by moving its posts to the chosen section with the board version', async () => {
  render(<BoardWorkspace boardId="preview-board" />);
  const heading = await screen.findByRole('heading', { name: '2조 1' });
  const menu = heading.closest('section')!.querySelector('details')!;
  menu.setAttribute('open', '');
  fireEvent.click(within(menu).getByRole('button', { name: '섹션 삭제' }));
  const dialog = screen.getByRole('dialog', { name: '섹션 삭제' });
  fireEvent.change(within(dialog).getByRole('combobox'), { target: { value: 'section-3' } });
  fireEvent.click(within(dialog).getByRole('button', { name: '섹션 삭제' }));
  await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/boards/preview-board/sections/section-2', expect.objectContaining({ method: 'DELETE', body: JSON.stringify({ version: boardFixture.board.version, move_to: 'section-3' }) })));
});

it('lists saved drafts and reopens one in the composer', async () => {
  const draft = { id: '00000000-0000-4000-8000-000000000001', board_id: 'preview-board', principal_id: 'teacher', edit_post_id: null, edit_post_version: null, section_id: 'section-1', title: '작성 중인 생각', body: '', link: '', color: '#ffffff', attachment_ids: [], version: 2, created_at: '2026-10-12T00:00:00Z', updated_at: '2026-10-12T00:00:00Z' };
  vi.stubGlobal('fetch', vi.fn(async (path: string) => new Response(JSON.stringify({ data: path.endsWith('/drafts') ? [draft] : path.endsWith(`/drafts/${draft.id}`) ? draft : path === '/api/upload-policy' ? { images_only: true, max_bytes: 1048576 } : boardFixture }))));
  render(<BoardWorkspace boardId="preview-board" />);
  fireEvent.click(await screen.findByRole('button', { name: '작성 중인 생각' }));
  const dialog = screen.getByRole('dialog', { name: '새로운 생각 남기기' });
  await waitFor(() => expect((within(dialog).getByRole('textbox', { name: '제목' }) as HTMLInputElement).value).toBe('작성 중인 생각'));
});

it('opens presentation mode for a single section from the section menu', async () => {
  render(<BoardWorkspace boardId="preview-board" />);
  const heading = await screen.findByRole('heading', { name: '2조 1' });
  const menu = heading.closest('section')!.querySelector('details')!;
  menu.setAttribute('open', '');
  fireEvent.click(within(menu).getByRole('button', { name: '이 섹션 발표' }));
  const presentation = screen.getByRole('dialog', { name: '게시판 발표' });
  expect((within(presentation).getByRole('combobox', { name: '발표 범위' }) as HTMLSelectElement).value).toBe('section-2');
});

const dataTransfer = { setData: () => undefined, effectAllowed: 'move' };
const columnOf = async (name: string | RegExp) => (await screen.findByRole('heading', { name })).closest('section')!;

it('reorders posts within a section by drag with the full section order and board version', async () => {
  const extra = { ...boardFixture.posts[0], id: 'post-extra', title: '추가 글' };
  const view = { ...boardFixture, posts: [...boardFixture.posts, extra] };
  vi.stubGlobal('fetch', vi.fn(async (path: string) => new Response(JSON.stringify({ data: path.endsWith('/drafts') ? [] : view }))));
  render(<BoardWorkspace boardId="preview-board" />);
  const column = await columnOf('1조 2');
  const [first, second] = Array.from(column.querySelectorAll('article'));
  fireEvent.dragStart(second, { dataTransfer });
  fireEvent.dragOver(first, { dataTransfer });
  fireEvent.drop(first, { dataTransfer });
  await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/boards/preview-board/posts/reorder', expect.objectContaining({ method: 'POST', body: JSON.stringify({ version: boardFixture.board.version, section_id: 'section-1', post_ids: ['post-extra', 'post-0'] }) })));
});

it('moves a post to another section by drag before the target card', async () => {
  render(<BoardWorkspace boardId="preview-board" />);
  const source = (await columnOf('1조 1')).querySelector('article')!;
  const target = (await columnOf('2조 1')).querySelector('article')!;
  fireEvent.dragStart(source, { dataTransfer });
  fireEvent.drop(target, { dataTransfer });
  await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/posts/post-0', expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ version: 1, section_id: 'section-2', rank: 99 }) })));
});

it('reorders sections by dragging a section heading', async () => {
  render(<BoardWorkspace boardId="preview-board" />);
  const third = await columnOf('3조 1');
  fireEvent.dragStart(third.querySelector('.boards-section-heading')!, { dataTransfer });
  fireEvent.drop(await columnOf('1조 1'), { dataTransfer });
  await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/boards/preview-board/sections/reorder', expect.objectContaining({ body: JSON.stringify({ version: boardFixture.board.version, section_ids: ['section-3', 'section-1', 'section-2', 'section-4'] }) })));
});

it('does not make cards draggable for students', async () => {
  const studentView = { ...boardFixture, principal: { id: 'student', role: 'student', display_name: '예시 학생' }, can_manage: false };
  vi.stubGlobal('fetch', vi.fn(async (path: string) => new Response(JSON.stringify({ data: path.endsWith('/drafts') ? [] : studentView }))));
  render(<BoardWorkspace boardId="preview-board" />);
  const column = await columnOf(/^1조/);
  expect(column.querySelector('[draggable="true"]')).toBeNull();
});

it('lists recent posts and comments newest first in the activity panel', async () => {
  const view = { ...boardFixture, posts: boardFixture.posts.map((post, n) => ({ ...post, created_at: `2026-10-12T0${n}:00:00Z`, comments: n === 0 ? [{ id: 'c1', body: '좋아요', author_name: '댓글 작성자', is_mine: false, created_at: '2026-10-12T09:00:00Z' }] : [] })) };
  vi.stubGlobal('fetch', vi.fn(async (path: string) => new Response(JSON.stringify({ data: path.endsWith('/drafts') ? [] : view }))));
  render(<BoardWorkspace boardId="preview-board" />);
  fireEvent.click(await screen.findByRole('button', { name: '최근 활동' }));
  const items = within(screen.getByRole('dialog', { name: '최근 활동' })).getAllByRole('listitem');
  expect(items).toHaveLength(5);
  expect(items[0].textContent).toContain('댓글 작성자님이 댓글을 남겼어요');
  expect(items[1].textContent).toContain(boardFixture.posts[3].title);
});

it('renames the board by clicking its title and cancels with Escape', async () => {
  render(<BoardWorkspace boardId="preview-board" />);
  fireEvent.click(await screen.findByRole('button', { name: '물리 변화와 화학 변화' }));
  let input = screen.getByRole('textbox', { name: '게시판 이름' }) as HTMLInputElement;
  expect(document.activeElement).toBe(input);
  fireEvent.change(input, { target: { value: '바꾸지 않을 합성 제목' } });
  fireEvent.keyDown(input, { key: 'Escape' });
  expect(vi.mocked(fetch).mock.calls.some(([path, init]) => path === '/api/boards/preview-board' && init?.method === 'PATCH')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: '물리 변화와 화학 변화' }));
  input = screen.getByRole('textbox', { name: '게시판 이름' }) as HTMLInputElement;
  fireEvent.change(input, { target: { value: '  상태 변화 탐구  ' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/boards/preview-board', expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ title: '상태 변화 탐구', version: 1 }) })));
  expect(screen.queryByRole('textbox', { name: '게시판 이름' })).toBeNull();
});

it('closes open menus on an outside click, on Escape, and after choosing an item', async () => {
  render(<BoardWorkspace boardId="preview-board" />);
  const summary = await screen.findByLabelText('얼음이 녹으면 어떤 변화일까요? 게시물 작업');
  const menu = summary.closest('details')!, other = screen.getByLabelText('사용자 메뉴').closest('details')!;
  menu.open = true;
  fireEvent.pointerDown(menu.querySelector('div')!);
  expect(menu.open).toBe(true);
  fireEvent.pointerDown(document.body);
  expect(menu.open).toBe(false);
  menu.open = true; other.open = true;
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(menu.open || other.open).toBe(false);
  menu.open = true;
  fireEvent.click(within(menu).getByRole('button', { name: '게시물 수정' }));
  expect(menu.open).toBe(false);
  expect(screen.getByRole('dialog')).toBeTruthy();
  expect(within(menu.closest('article')!).getByPlaceholderText('댓글')).toBeTruthy();
});

it('lets a teacher delete a comment and offers to publish waiting posts when approval is turned off', async () => {
  const comment = { id: 'comment-1', body: '합성 댓글', author_name: '예시 참여자', is_mine: false, created_at: '2026-10-12T00:00:00Z' };
  const view = { ...boardFixture, board: { ...boardFixture.board, moderation: true }, posts: boardFixture.posts.map((post, n) => n === 0 ? { ...post, status: 'pending', comments: [comment] } : post) };
  const calls: [string, RequestInit | undefined][] = [];
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => { calls.push([path, init]); return new Response(JSON.stringify({ data: path === '/api/upload-policy' ? { images_only: true, max_bytes: 1048576 } : path.endsWith('/drafts') ? [] : view })); }));
  const confirm = vi.fn(() => true); vi.stubGlobal('confirm', confirm);
  render(<BoardWorkspace boardId="preview-board" />);
  fireEvent.click(await screen.findByRole('button', { name: '예시 참여자 댓글 삭제' }));
  await waitFor(() => expect(calls.some(([path, init]) => path === '/api/posts/post-0/comments/comment-1' && init?.method === 'DELETE')).toBe(true));
  fireEvent.click(screen.getByRole('button', { name: '게시판 설정' }));
  const dialog = screen.getByRole('dialog', { name: '수업 공간 설정' });
  fireEvent.click(within(dialog).getByRole('switch', { name: /교사 승인 후 공개/ }));
  fireEvent.click(within(dialog).getByRole('button', { name: '설정 저장' }));
  await waitFor(() => expect(calls.some(([path, init]) => path === '/api/boards/preview-board' && init?.method === 'PATCH')).toBe(true));
  const patch = calls.find(([path, init]) => path === '/api/boards/preview-board' && init?.method === 'PATCH')!;
  expect(JSON.parse(String(patch[1]!.body))).toMatchObject({ moderation: false, publish_pending: true });
  expect(confirm).toHaveBeenLastCalledWith(expect.stringContaining('승인 대기 중인 글 1개'));
});
