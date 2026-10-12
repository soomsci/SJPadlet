-- Run only in the dedicated Supabase project for this school application.
-- Browser clients have no direct access to application records or file objects.
DO $$
DECLARE name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['principals','sessions','oauth_states','boards','board_members','sections','share_links','participations','board_blocks','posts','comments','reactions','storage_budget','attachments','audit_events','outbox_events','idempotency','favorites','rate_limits','post_drafts','teacher_admissions','operation_runs','backup_object_refs'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', name);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon, authenticated', name);
  END LOOP;
END $$;
REVOKE ALL ON SEQUENCE public.outbox_events_id_seq FROM anon, authenticated;

-- Fail closed if a pre-existing policy could grant broader message access.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='realtime' AND tablename='messages' AND policyname <> 'moa_receive_invalidations') THEN
    RAISE EXCEPTION 'Use a dedicated Supabase project; review existing Realtime policies before migration';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='storage' AND tablename='objects') THEN
    RAISE EXCEPTION 'Use a dedicated Supabase project; review existing Storage policies before migration';
  END IF;
END $$;
GRANT USAGE ON SCHEMA realtime TO authenticated;
GRANT SELECT ON realtime.messages TO authenticated;
DROP POLICY IF EXISTS moa_receive_invalidations ON realtime.messages;
CREATE POLICY moa_receive_invalidations ON realtime.messages FOR SELECT TO authenticated
USING (
  extension = 'broadcast'
  AND (SELECT auth.jwt()->>'moa_capability') = 'realtime-only'
  AND (SELECT auth.jwt()->>'moa_topic') = (SELECT realtime.topic())
  AND topic = (SELECT realtime.topic())
);

CREATE OR REPLACE FUNCTION public.moa_broadcast_invalidation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  -- Only an empty notification is published. Never broadcast NEW/OLD records,
  -- titles, student identities, share tokens, post IDs or pending answers.
  PERFORM realtime.send('{}'::jsonb, 'invalidate', 'moa:board:' || NEW.board_id, true);
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.moa_broadcast_invalidation() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS moa_outbox_broadcast ON public.outbox_events;
CREATE TRIGGER moa_outbox_broadcast AFTER INSERT ON public.outbox_events
FOR EACH ROW EXECUTE FUNCTION public.moa_broadcast_invalidation();

INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
VALUES('classroom-images','classroom-images',false,1048576,ARRAY['image/jpeg','image/png','image/webp'])
ON CONFLICT(id) DO UPDATE SET public=false,file_size_limit=1048576,allowed_mime_types=EXCLUDED.allowed_mime_types;
-- No storage.objects policies are created: file access goes through the Worker.
