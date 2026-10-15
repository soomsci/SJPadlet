import type { SupabaseClient } from '@supabase/supabase-js';
import { api, ApiRequestError } from '@ui';
type Ticket = { mode: 'supabase'; url: string; key: string; topic: string; token: string; expires_in: number } | { mode: 'sse' };

export function watchBoard(boardId: string, refresh: () => Promise<void>, status: (connected: boolean) => void) {
  let stopped = false, client: SupabaseClient | undefined, stream: EventSource | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined, debounce: ReturnType<typeof setTimeout> | undefined;
  let inflight = false, pending = false;
  const invalidate = () => {
    if (stopped) return;
    pending = true;
    if (inflight || debounce) return;
    debounce = setTimeout(async () => {
      debounce = undefined;
      if (stopped) return;
      inflight = true; pending = false;
      try { await refresh(); } finally { inflight = false; if (pending) invalidate(); }
    }, 1000 + Math.random() * 2000); // Spread clients and coalesce bursts (likes, comments) so one class does not refetch per event.
  };
  const renew = async () => {
    if (stopped) return;
    try {
      const ticket = await api<Ticket>(`/api/boards/${boardId}/realtime-ticket`);
      if (stopped) return;
      if (ticket.mode === 'sse') {
        stream = new EventSource(`/api/boards/${boardId}/events`);
        stream.onopen = () => { status(true); invalidate(); };
        stream.onerror = () => status(false);
        stream.onmessage = invalidate;
        stream.addEventListener('revoked', () => { stream?.close(); status(false); invalidate(); });
        return;
      }
      if (!client) {
        const { createClient } = await import('@supabase/supabase-js');
        if (stopped) return;
        client = createClient(ticket.url, ticket.key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
        await client.realtime.setAuth(ticket.token);
        if (stopped) { await client.removeAllChannels(); client.realtime.disconnect(); return; }
        client.channel(ticket.topic, { config: { private: true } })
          .on('broadcast', { event: 'invalidate' }, invalidate)
          .subscribe(value => { if (!stopped) { status(value === 'SUBSCRIBED'); if (value === 'SUBSCRIBED') invalidate(); } });
      } else await client.realtime.setAuth(ticket.token);
      if (!stopped) {
        // No refetch here: the ticket request itself rechecks board access (a revoked viewer lands in catch and refreshes),
        // and missed notifications are caught by SUBSCRIBED, visibility and online events. Refetching every renewal
        // cost a full board read per student every 45 seconds even when nothing changed.
        timer = setTimeout(() => { void renew(); }, (ticket.expires_in - 15) * 1000);
      }
    } catch (error) {
      if (stopped) return;
      status(false); invalidate();
      if (client) { await client.removeAllChannels(); client.realtime.disconnect(); client = undefined; }
      if (error instanceof ApiRequestError && [401, 403, 404].includes(error.status)) return;
      timer = setTimeout(() => { void renew(); }, 15000);
    }
  };
  const onVisible = () => { if (document.visibilityState === 'visible') invalidate(); };
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('online', onVisible);
  void renew();
  return () => {
    stopped = true; clearTimeout(timer); clearTimeout(debounce); stream?.close();
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('online', onVisible);
    if (client) { void client.removeAllChannels(); client.realtime.disconnect(); }
  };
}
