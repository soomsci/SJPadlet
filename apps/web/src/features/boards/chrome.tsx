'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { Layers, LogOut, Search, ShieldCheck } from 'lucide-react';
import type { BoardView } from '@contracts';
import { api, Notice } from '@ui';

/** Open "more" menus (<details>) close on an outside click, on Escape, or once one of their items is chosen. */
function useMenuDismiss() {
  useEffect(() => {
    const open = () => Array.from(document.querySelectorAll<HTMLDetailsElement>('details.boards-more[open]'));
    const onPointer = (event: PointerEvent) => { for (const menu of open()) if (!menu.contains(event.target as Node)) menu.open = false; };
    const onClick = (event: MouseEvent) => { const item = (event.target as Element | null)?.closest?.('button, a'); const menu = item?.closest<HTMLDetailsElement>('details.boards-more'); if (menu) menu.open = false; };
    const onKey = (event: KeyboardEvent) => { if (event.key !== 'Escape') return; for (const menu of open()) { menu.open = false; menu.querySelector<HTMLElement>('summary')?.focus(); } };
    document.addEventListener('pointerdown', onPointer); document.addEventListener('click', onClick); document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onPointer); document.removeEventListener('click', onClick); document.removeEventListener('keydown', onKey); };
  }, []);
}

export function BoardChrome({ principal, query, onQuery, children }: { principal: BoardView['principal']; query: string; onQuery: (query: string) => void; children: ReactNode }) {
  const [error, setError] = useState('');
  useMenuDismiss();
  async function logout() {
    try { await api('/api/auth/logout', { method: 'POST' }); window.location.assign('/'); }
    catch { setError('로그아웃하지 못했습니다. 다시 시도해주세요.'); }
  }
  return <>
    <nav className="board-topbar" aria-label="게시판 도구">
      <a className="board-brand" href={principal.role === 'admin' || principal.role === 'teacher' ? '/dashboard' : '/'} aria-label="모아 홈"><Layers size={24} /><strong>모아<span>.</span></strong></a>
      <div className="board-topbar-controls">
        <label className="board-search"><Search size={19} /><input aria-label="생각 검색" value={query} onChange={event => onQuery(event.target.value)} placeholder="검색" /></label>
        {children}
        <details className="boards-more board-account">
          <summary aria-label="사용자 메뉴" className="board-user-avatar">{principal.display_name.slice(0, 1)}</summary>
          <div><strong>{principal.display_name}</strong>{(principal.role === 'teacher' || principal.role === 'admin') && <a href="/dashboard">내 게시판</a>}<a href="/join">활동 참여</a>{principal.role === 'admin' && <a href="/admin"><ShieldCheck size={16} />학교 관리</a>}<button onClick={() => void logout()}><LogOut size={16} />로그아웃</button></div>
        </details>
      </div>
    </nav>
    {error && <Notice>{error}</Notice>}
  </>;
}
