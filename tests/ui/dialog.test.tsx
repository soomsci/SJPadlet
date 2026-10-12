// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Dialog } from '../../apps/web/src/features/boards/dialog';

afterEach(cleanup);

describe('board editing dialog', () => {
  it('keeps the section name focused through typing and parent refreshes', () => {
    function SectionEditor({ refresh }: { refresh: number }) {
      const [name, setName] = useState('1조');
      return <Dialog title="섹션 이름 수정" onClose={() => undefined}><label>섹션 이름<input value={name} onChange={event => setName(event.target.value)} /></label><span>{refresh}</span><button>섹션 저장</button></Dialog>;
    }
    const { rerender } = render(<SectionEditor refresh={0} />);
    const input = screen.getByRole('textbox', { name: '섹션 이름' }) as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    for (const value of ['1조 ', '1조 새', '1조 새 이름']) {
      fireEvent.change(input, { target: { value } });
      expect(document.activeElement).toBe(input);
    }
    input.setSelectionRange(3, 3);
    rerender(<SectionEditor refresh={1} />);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe('1조 새 이름');
    expect(input.selectionStart).toBe(3);
  });

  it('preserves focus in the body and uses the latest close callback', () => {
    const initial = vi.fn(), latest = vi.fn();
    const content = <><input aria-label="제목" /><textarea aria-label="내용" /></>;
    const { rerender } = render(<Dialog title="작성" onClose={initial}>{content}</Dialog>);
    const textarea = screen.getByRole('textbox', { name: '내용' });
    textarea.focus();
    rerender(<Dialog title="작성" onClose={latest}>{content}</Dialog>);
    expect(document.activeElement).toBe(textarea);
    fireEvent.keyDown(textarea, { key: 'Escape' });
    expect(initial).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledOnce();
  });

  it('traps keyboard navigation and restores the opener on close', () => {
    function Editor() {
      const [open, setOpen] = useState(false);
      return <><button onClick={() => setOpen(true)}>이름 수정</button>{open && <Dialog title="수정" onClose={() => setOpen(false)}><input aria-label="이름" /><button>저장</button></Dialog>}</>;
    }
    render(<Editor />);
    const opener = screen.getByRole('button', { name: '이름 수정' });
    opener.focus(); fireEvent.click(opener);
    const close = screen.getByRole('button', { name: '닫기' }), save = screen.getByRole('button', { name: '저장' });
    save.focus(); fireEvent.keyDown(save, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(save);
    fireEvent.keyDown(save, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('does not close while Korean input composition is active', () => {
    const onClose = vi.fn();
    render(<Dialog title="이름 수정" onClose={onClose}><input aria-label="이름" /></Dialog>);
    const input = screen.getByRole('textbox');
    fireEvent.keyDown(input, { key: 'Escape', isComposing: true });
    fireEvent.keyDown(input, { key: 'Escape', keyCode: 229 });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
