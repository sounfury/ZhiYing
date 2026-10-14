-- 结果版本存储：每个版本整体序列化成带格式版本号的 JSON 存一行；已发布指针每本书一行，发布即切换指针。
-- 不对书表建外键：书与章节由 library 模块的脚本维护，这里只按 book_id 关联。
CREATE TABLE IF NOT EXISTS analysis_revision (
    revision_id    TEXT PRIMARY KEY,
    book_id        TEXT NOT NULL,
    format_version INTEGER NOT NULL,
    method_version TEXT,
    full_book      INTEGER NOT NULL DEFAULT 0,
    payload        TEXT NOT NULL,
    created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_analysis_revision_book ON analysis_revision (book_id);

CREATE TABLE IF NOT EXISTS published_revision (
    book_id      TEXT PRIMARY KEY,
    revision_id  TEXT NOT NULL REFERENCES analysis_revision (revision_id),
    published_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- 把章抽取固定到结果版本；重读期间仍可查看上一版的摘要与证据。
CREATE TABLE IF NOT EXISTS revision_extraction (
    revision_id TEXT NOT NULL REFERENCES analysis_revision (revision_id) ON DELETE CASCADE,
    chapter_id TEXT NOT NULL,
    extraction_id TEXT NOT NULL REFERENCES chapter_extraction (extraction_id),
    PRIMARY KEY (revision_id, chapter_id)
);

-- 兼容已有结果：只在没有运行中任务时补齐旧版本的抽取快照。
INSERT OR IGNORE INTO revision_extraction (revision_id, chapter_id, extraction_id)
SELECT p.revision_id, c.chapter_id, c.extraction_id
FROM published_revision p
JOIN chapter_extraction_current c ON c.book_id = p.book_id
WHERE NOT EXISTS (
    SELECT 1 FROM analysis_task t WHERE t.book_id = p.book_id AND t.status = 'RUNNING'
);
