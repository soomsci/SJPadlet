'use client';

import { useState, type ReactNode } from 'react';
import { Layers, LogOut, Search, ShieldCheck } from 'lucide-react';
import type { BoardView } from '@contracts';
import { api, Notice } from '@ui';

export function BoardChrome({ principal, query, onQuery, children }: { principal: BoardView['principal']; query: string; onQuery: (query: string) => void; children: ReactNode }) {
  const [error, setError] = useState('');
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
