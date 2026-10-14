-- 账号、限次邀请码、持久登录与书架条目；条目保存归属，书可共享。
CREATE TABLE IF NOT EXISTS accounts (
    id            TEXT PRIMARY KEY,
    username      TEXT NOT NULL COLLATE NOCASE UNIQUE,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL CHECK (role IN ('ADMIN', 'USER')),
    created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS invitations (
    code       TEXT PRIMARY KEY,
    max_uses   INTEGER NOT NULL CHECK (max_uses > 0),
    used_count INTEGER NOT NULL DEFAULT 0 CHECK (used_count >= 0 AND used_count <= max_uses),
    created_by TEXT NOT NULL REFERENCES accounts(id),
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS account_sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_account_sessions_user ON account_sessions(user_id);

CREATE TABLE IF NOT EXISTS shelf_items (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES accounts(id),
    book_id         TEXT NOT NULL REFERENCES books(id),
    pending_book_id TEXT REFERENCES books(id),
    original_name   TEXT NOT NULL,
    created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shelf_items_user ON shelf_items(user_id);
CREATE INDEX IF NOT EXISTS idx_shelf_items_book ON shelf_items(book_id);
CREATE INDEX IF NOT EXISTS idx_shelf_items_pending ON shelf_items(pending_book_id);
