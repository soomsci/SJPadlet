// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
const { apiMock, channel, subscription } = vi.hoisted(() => {
  const subscription: { callback?: (status: string) => void } = {};
  const channel = { on: () => channel, subscribe: (callback: (status: string) => void) => { subscription.callback = callback; return channel; } };
  return { apiMock: vi.fn(), channel, subscription };
});
vi.mock('@ui', async importOriginal => ({ ...await importOriginal<object>(), api: apiMock }));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ realtime: { setAuth: async () => {}, disconnect: () => {} }, channel: () => channel, removeAllChannels: async () => {} }) }));
import { watchBoard } from '@features/live';

afterEach(() => { vi.useRealTimers(); apiMock.mockReset(); });
it('renews the realtime ticket without refetching an unchanged board', async () => {
  vi.useFakeTimers();
  apiMock.mockResolvedValue({ mode: 'supabase', url: 'https://school.supabase.co', key: 'sb_publishable_test', topic: 'moa:board:b', token: 'synthetic', expires_in: 60 });
  const refresh = vi.fn(async () => {});
  const stop = watchBoard('b', refresh, () => {});
  await vi.advanceTimersByTimeAsync(0);
  subscription.callback?.('SUBSCRIBED');
  await vi.advanceTimersByTimeAsync(3500);
  expect(refresh).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(3 * 45000);
  expect(apiMock).toHaveBeenCalledTimes(4);
  expect(refresh).toHaveBeenCalledTimes(1);
  stop();
});
