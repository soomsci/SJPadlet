export const schema = `
CREATE TABLE IF NOT EXISTS principals (
 id TEXT PRIMARY KEY, role TEXT NOT NULL CHECK(role IN ('admin','teacher','student','anonymous')),
 display_name TEXT NOT NULL, email TEXT, disabled_at TEXT, provider_subject TEXT UNIQUE, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, principal_id TEXT NOT NULL REFERENCES principals(id), token_hash TEXT UNIQUE NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS oauth_states (id TEXT PRIMARY KEY, state_hash TEXT UNIQUE NOT NULL, nonce TEXT NOT NULL, code_verifier TEXT NOT NULL, return_to TEXT NOT NULL, intent TEXT NOT NULL, previous_principal_id TEXT, expires_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS boards (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES principals(id), title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
 format TEXT NOT NULL CHECK(format IN ('wall','grid','columns')), state TEXT NOT NULL CHECK(state IN ('draft','open','closed','archived')),
 participation_mode TEXT NOT NULL CHECK(participation_mode IN ('both','login')), moderation BOOLEAN NOT NULL DEFAULT false,
 allow_comments BOOLEAN NOT NULL DEFAULT true, allow_reactions BOOLEAN NOT NULL DEFAULT true, anonymous_display BOOLEAN NOT NULL DEFAULT true,
 color TEXT NOT NULL DEFAULT '#e9eee7', version INTEGER NOT NULL DEFAULT 1, deleted_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS board_members (board_id TEXT NOT NULL REFERENCES boards(id), principal_id TEXT NOT NULL REFERENCES principals(id), role TEXT NOT NULL CHECK(role IN ('editor','reader')), PRIMARY KEY(board_id,principal_id));
CREATE TABLE IF NOT EXISTS sections (id TEXT PRIMARY KEY, board_id TEXT NOT NULL REFERENCES boards(id), title TEXT NOT NULL, rank INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS share_links (id TEXT PRIMARY KEY, board_id TEXT NOT NULL REFERENCES boards(id), target_type TEXT NOT NULL CHECK(target_type IN ('board','post','section','submission')), target_id TEXT NOT NULL, scope TEXT NOT NULL CHECK(scope IN ('read','write')), token_hash TEXT NOT NULL UNIQUE, code_hash TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL, revoked_at TEXT, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS participations (id TEXT PRIMARY KEY, principal_id TEXT NOT NULL REFERENCES principals(id), board_id TEXT NOT NULL REFERENCES boards(id), share_id TEXT NOT NULL REFERENCES share_links(id), share_version INTEGER NOT NULL, blocked_at TEXT, created_at TEXT NOT NULL, UNIQUE(principal_id,share_id));
CREATE TABLE IF NOT EXISTS board_blocks (board_id TEXT NOT NULL REFERENCES boards(id), principal_id TEXT NOT NULL REFERENCES principals(id), created_at TEXT NOT NULL, PRIMARY KEY(board_id,principal_id));
CREATE TABLE IF NOT EXISTS posts (id TEXT PRIMARY KEY, board_id TEXT NOT NULL REFERENCES boards(id), section_id TEXT REFERENCES sections(id), author_id TEXT NOT NULL REFERENCES principals(id), title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', link TEXT, status TEXT NOT NULL CHECK(status IN ('pending','published','rejected','hidden','deleted')), color TEXT NOT NULL DEFAULT '#ffffff', rank INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS comments (id TEXT PRIMARY KEY, post_id TEXT NOT NULL REFERENCES posts(id), author_id TEXT NOT NULL REFERENCES principals(id), body TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS reactions (post_id TEXT NOT NULL REFERENCES posts(id), principal_id TEXT NOT NULL REFERENCES principals(id), PRIMARY KEY(post_id,principal_id));
CREATE TABLE IF NOT EXISTS storage_budget (id INTEGER PRIMARY KEY CHECK(id=1));
INSERT INTO storage_budget(id) VALUES(1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS attachments (id TEXT PRIMARY KEY, board_id TEXT NOT NULL REFERENCES boards(id), post_id TEXT REFERENCES posts(id), uploader_id TEXT NOT NULL REFERENCES principals(id), name TEXT NOT NULL, mime TEXT NOT NULL, bytes INTEGER NOT NULL, storage_key TEXT NOT NULL UNIQUE, status TEXT NOT NULL CHECK(status IN ('quarantined','ready','rejected')), created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit_events (id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, action TEXT NOT NULL, target_id TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS outbox_events (id BIGSERIAL PRIMARY KEY, board_id TEXT NOT NULL, event_type TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS idempotency (principal_id TEXT NOT NULL, key TEXT NOT NULL, result_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(principal_id,key));
CREATE TABLE IF NOT EXISTS favorites (principal_id TEXT NOT NULL REFERENCES principals(id), board_id TEXT NOT NULL REFERENCES boards(id), PRIMARY KEY(principal_id,board_id));
CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, resets_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS posts_board_idx ON posts(board_id,created_at);
CREATE INDEX IF NOT EXISTS participations_board_idx ON participations(principal_id,board_id);
CREATE INDEX IF NOT EXISTS outbox_board_idx ON outbox_events(board_id,id);
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
ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS board_id TEXT;
CREATE INDEX IF NOT EXISTS audit_events_board_idx ON audit_events(board_id,created_at) WHERE board_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS board_member_invites (board_id TEXT NOT NULL REFERENCES boards(id),email TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('editor','reader')),invited_by TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(board_id,email));
CREATE INDEX IF NOT EXISTS board_member_invites_email_idx ON board_member_invites(email);
`;
