// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { JoinPage } from '@features/join';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('defaults a shared device to a new identity and makes continuing or linking explicit', async () => {
  const fetchMock = vi.fn(async (path: string, _init?: RequestInit) => new Response(JSON.stringify({ data: path.includes('/api/me') ? { principal: { id: 'previous', role: 'anonymous', display_name: '이전 학생' }, google_configured: true, demo_enabled: false } : path.includes('share-preview') ? { participation_mode: 'both' } : { destination: '/boards/b' } })));
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('location', { ...window.location, assign: vi.fn(), search: '' });
  render(<JoinPage token="synthetic-token-synthetic-token" />);
  expect((await screen.findByRole('link', { name: 'Google로 로그인' })).getAttribute('href')).toContain('intent=student');
  expect(screen.getByRole('link', { name: '이전 학생 님의 익명 글 연결' }).getAttribute('href')).toContain('intent=link');
  const body = () => JSON.parse(String(fetchMock.mock.calls.find(([path]) => path === '/api/join')![1]!.body));
  fireEvent.click(screen.getByRole('button', { name: /새로 익명 참여/ }));
  await waitFor(() => expect(body()).not.toHaveProperty('continue'));
  cleanup(); fetchMock.mockClear();
  render(<JoinPage token="synthetic-token-synthetic-token" />);
  fireEvent.click(await screen.findByRole('button', { name: /이전 학생 님으로 이어가기/ }));
  await waitFor(() => expect(body()).toMatchObject({ continue: true }));
});
