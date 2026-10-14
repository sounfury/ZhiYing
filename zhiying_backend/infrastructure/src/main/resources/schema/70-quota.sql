-- 每个分析任务一条用量流水；不对书建外键，删除书或清空分析不退还额度。
CREATE TABLE IF NOT EXISTS usage_ledger (
    task_id     TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    item_id     TEXT NOT NULL,
    chars       INTEGER NOT NULL CHECK (chars >= 0),
    tokens      INTEGER NOT NULL DEFAULT 0 CHECK (tokens >= 0),
    started_at  TEXT NOT NULL,
    settled_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_usage_ledger_user ON usage_ledger (user_id);
CREATE INDEX IF NOT EXISTS idx_usage_ledger_started ON usage_ledger (started_at);
