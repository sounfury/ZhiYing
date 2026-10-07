-- 结果版本存储：每个版本整体序列化成带格式版本号的 JSON 存一行；已发布指针每本书一行，发布即切换指针。
-- 不对书表建外键：书与章节由 library 模块的脚本维护，这里只按 book_id 关联。
CREATE TABLE IF NOT EXISTS analysis_revision (
    revision_id    TEXT PRIMARY KEY,
    book_id        TEXT NOT NULL,
    format_version INTEGER NOT NULL,
    payload        TEXT NOT NULL,
    created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_analysis_revision_book ON analysis_revision (book_id);

CREATE TABLE IF NOT EXISTS published_revision (
    book_id      TEXT PRIMARY KEY,
    revision_id  TEXT NOT NULL REFERENCES analysis_revision (revision_id),
    published_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
