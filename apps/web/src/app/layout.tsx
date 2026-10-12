import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { AppHeader } from './shell';
import './globals.css';
export const metadata: Metadata={title:{default:'모아 · 삼정학교 협업보드',template:'%s · 모아'},description:'생각이 모이고, 배움이 자라는 우리 학교 협업 공간',robots:{index:false,follow:false}};
export default function RootLayout({children}:{children:ReactNode}){return <html lang="ko"><body><a className="skip-link" href="#main">본문 바로가기</a><AppHeader/><div id="main">{children}</div><footer className="site-footer"><span>모아 <span className="footer-dot">·</span> 삼정학교 협업보드</span><span>작은 생각이 모여, 더 큰 배움으로.</span></footer></body></html>;}
