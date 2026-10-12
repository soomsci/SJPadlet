'use client';

import { useEffect, useEffectEvent, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';

export function Dialog({ title, children, onClose, wide = false, variant = 'default' }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean; variant?: 'default' | 'compose' | 'settings' }) {
  const element = useRef<HTMLDivElement>(null);
  const closeFromKeyboard = useEffectEvent(onClose);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = element.current;
    const editable = dialog?.querySelector<HTMLElement>('input:not([disabled]):not([type="hidden"]),textarea:not([disabled]),select:not([disabled])');
    (editable ?? dialog?.querySelector<HTMLElement>('button:not([disabled])') ?? dialog)?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Escape') { event.preventDefault(); closeFromKeyboard(); return; }
      if (event.key !== 'Tab') return;
      const items = Array.from(dialog?.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),textarea:not([disabled]),select:not([disabled]),[tabindex="0"]') ?? []);
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); if (previous?.isConnected) previous.focus(); };
  }, []);
  return <div className={`modal-backdrop board-dialog-backdrop-${variant}`} onClick={event => { if (event.target === event.currentTarget) onClose(); }}><div ref={element} tabIndex={-1} className={`modal boards-dialog board-dialog-${variant}${wide ? ' boards-dialog-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}><div className="boards-dialog-heading"><h2>{title}</h2><button type="button" className="button ghost icon-button" aria-label="닫기" onClick={onClose}><X size={20} /></button></div>{children}</div></div>;
}
