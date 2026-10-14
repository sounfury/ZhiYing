-- 账号、限次邀请码、持久登录与书籍归属；其他书籍数据经 book_id 继承上传者。
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

CREATE TABLE IF NOT EXISTS book_owners (
    book_id TEXT PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES accounts(id)
);
CREATE INDEX IF NOT EXISTS idx_book_owners_user ON book_owners(user_id);
