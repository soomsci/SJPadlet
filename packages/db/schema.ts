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
`;
