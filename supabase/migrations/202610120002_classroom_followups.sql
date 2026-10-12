-- Versioned follow-up migration; initial deployed migration remains unchanged.
ALTER TABLE boards ADD COLUMN IF NOT EXISTS column_width INTEGER NOT NULL DEFAULT 300 CHECK(column_width BETWEEN 260 AND 440);
ALTER TABLE boards ADD COLUMN IF NOT EXISTS font_scale TEXT NOT NULL DEFAULT 'normal' CHECK(font_scale IN ('small','normal','large'));
ALTER TABLE boards ADD COLUMN IF NOT EXISTS card_density TEXT NOT NULL DEFAULT 'comfortable' CHECK(card_density IN ('comfortable','compact'));
ALTER TABLE boards ADD COLUMN IF NOT EXISTS background_style TEXT NOT NULL DEFAULT 'gradient' CHECK(background_style IN ('solid','gradient','paper'));
ALTER TABLE sections ADD COLUMN IF NOT EXISTS deleted_at TEXT;
CREATE TABLE IF NOT EXISTS post_drafts (
 id TEXT PRIMARY KEY,board_id TEXT NOT NULL REFERENCES boards(id),principal_id TEXT NOT NULL REFERENCES principals(id),
 edit_post_id TEXT REFERENCES posts(id),edit_post_version INTEGER,section_id TEXT REFERENCES sections(id),title TEXT NOT NULL DEFAULT '',body TEXT NOT NULL DEFAULT '',link TEXT NOT NULL DEFAULT '',
 color TEXT NOT NULL DEFAULT '#ffffff',attachment_ids JSONB NOT NULL DEFAULT '[]',version INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS post_drafts_owner_idx ON post_drafts(principal_id,board_id,updated_at);
CREATE TABLE IF NOT EXISTS teacher_admissions (email TEXT PRIMARY KEY,enabled BOOLEAN NOT NULL DEFAULT true,created_by TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS sections_board_active_idx ON sections(board_id,rank,id) WHERE deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS operation_runs (id TEXT PRIMARY KEY,kind TEXT NOT NULL CHECK(kind IN ('backup','cleanup','restore')),status TEXT NOT NULL CHECK(status IN ('running','completed','failed')),storage_key TEXT,bytes INTEGER NOT NULL DEFAULT 0,message TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,completed_at TEXT);
CREATE TABLE IF NOT EXISTS backup_object_refs (backup_id TEXT NOT NULL REFERENCES operation_runs(id) ON DELETE CASCADE,attachment_id TEXT NOT NULL,storage_key TEXT NOT NULL,bytes INTEGER NOT NULL,PRIMARY KEY(backup_id,attachment_id));
CREATE INDEX IF NOT EXISTS backup_object_refs_key_idx ON backup_object_refs(storage_key);

DO $$ DECLARE name text; BEGIN
FOREACH name IN ARRAY ARRAY['post_drafts','teacher_admissions','operation_runs','backup_object_refs'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', name);
 EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon, authenticated', name);
END LOOP; END $$;
INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
VALUES('school-backups','school-backups',false,12582912,ARRAY['application/octet-stream'])
ON CONFLICT(id) DO UPDATE SET public=false,file_size_limit=12582912,allowed_mime_types=EXCLUDED.allowed_mime_types;
