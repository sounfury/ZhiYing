-- 反馈独立保留提交快照，删除书或清空结果不级联删除反馈；仅管理员读取。
CREATE TABLE IF NOT EXISTS feedback (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    user_id TEXT NOT NULL,
    item_id TEXT,
    book_id TEXT,
    book_title TEXT,
    revision_id TEXT,
    target_kind TEXT NOT NULL CHECK (target_kind IN ('PERSON', 'RELATION', 'GROUP', 'GENERAL')),
    target_ref TEXT,
    target_label TEXT,
    category TEXT CHECK (category IN ('DUPLICATE_PERSON', 'WRONG_RELATION', 'WRONG_GROUP', 'MISSING', 'OTHER')),
    note TEXT,
    scope TEXT
);
CREATE INDEX IF NOT EXISTS feedback_item_created ON feedback(item_id, created_at DESC);
