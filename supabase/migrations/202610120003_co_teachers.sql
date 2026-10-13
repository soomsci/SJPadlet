-- Co-teacher membership invites and per-board teacher activity.
ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS board_id TEXT;
CREATE INDEX IF NOT EXISTS audit_events_board_idx ON audit_events(board_id,created_at) WHERE board_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS board_member_invites (board_id TEXT NOT NULL REFERENCES boards(id),email TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('editor','reader')),invited_by TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(board_id,email));
CREATE INDEX IF NOT EXISTS board_member_invites_email_idx ON board_member_invites(email);

ALTER TABLE public.board_member_invites ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.board_member_invites FROM anon, authenticated;
