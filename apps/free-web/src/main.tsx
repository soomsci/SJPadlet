import { createRoot } from 'react-dom/client';
import { AppHeader } from '../../web/src/app/shell';
import { HomeGate } from '../../web/src/app/home-gate';
import { Dashboard, BoardWorkspace } from '@features/boards';
import { LoginPage } from '@features/auth';
import { JoinPage } from '@features/join';
import { AdminPage } from '@features/admin';
import '../../web/src/app/globals.css';

function Route() {
  const { pathname, search } = window.location;
  const params = new URLSearchParams(search);
  const board = pathname.match(/^\/boards\/([a-zA-Z0-9-]+)\/?$/);
  const share = pathname.match(/^\/s\/([a-zA-Z0-9_-]+)\/?$/);
  if (board) return <BoardWorkspace boardId={board[1]} postId={params.get('post') ?? undefined} sectionId={params.get('section') ?? undefined} submission={params.get('submission') === '1'} />;
  if (share) return <JoinPage token={share[1]} />;
  if (pathname === '/login') return <LoginPage />;
  if (pathname === '/join') return <JoinPage />;
  if (pathname === '/dashboard') return <Dashboard />;
  if (pathname === '/admin') return <AdminPage />;
  if (pathname === '/') return <HomeGate />;
  return <main className="page-container"><h1>페이지를 찾을 수 없어요</h1><a className="button primary" href="/">홈으로</a></main>;
}

createRoot(document.getElementById('root')!).render(<><a className="skip-link" href="#main">본문 바로가기</a><AppHeader /><div id="main"><Route /></div><footer className="site-footer"><span>모아 · 삼정학교 협업보드</span><span>작은 생각이 모여, 더 큰 배움으로.</span></footer></>);
