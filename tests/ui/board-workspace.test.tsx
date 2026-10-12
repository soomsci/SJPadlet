// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { BoardWorkspace } from '../../apps/web/src/features/boards';
import { boardFixture } from './board-fixture';

vi.mock('@features/live', () => ({ watchBoard: () => () => undefined }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path.endsWith('/sections/section-1') && init?.method === 'PATCH') {
      const { title } = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ data: { ...boardFixture, sections: boardFixture.sections.map(s => s.id === 'section-1' ? { ...s, title } : s) } }));
    }
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
