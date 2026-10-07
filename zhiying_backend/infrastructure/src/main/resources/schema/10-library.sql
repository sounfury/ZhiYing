-- 书籍库：书、章节概要、章节正文。
-- chapters.ord 为从 1 开始的阅读序号（对前端即 chapter_id）；chapters.id 是稳定身份。
-- 正文单独成表，列章节时不会读到大文本；revision 为正文修订号，目前恒为 1。
CREATE TABLE IF NOT EXISTS books (
    id                    TEXT PRIMARY KEY,
    title                 TEXT NOT NULL,
    author                TEXT,
    source_ref            TEXT NOT NULL,     -- 源 EPUB 的内容摘要，文件在 booksDir 下
    original_name         TEXT NOT NULL,     -- 上传时的文件名
    imported_at           TEXT NOT NULL,     -- ISO-8601 UTC 时间
    total_chapters        INTEGER NOT NULL,
    analysis_chapters     INTEGER NOT NULL,
    total_words           INTEGER NOT NULL,
    max_chapter_words     INTEGER NOT NULL,
    median_chapter_words  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chapters (
    id                TEXT PRIMARY KEY,
    book_id           TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    ord               INTEGER NOT NULL,
    title             TEXT NOT NULL,
    word_count        INTEGER NOT NULL,
    source_href       TEXT NOT NULL,
    included          INTEGER NOT NULL,      -- 1 参与分析，0 不参与
    exclusion_reason  TEXT,                  -- 不参与时的原因（ExclusionReason 名称）
    UNIQUE (book_id, ord)
);

CREATE TABLE IF NOT EXISTS chapter_texts (
    chapter_id  TEXT PRIMARY KEY REFERENCES chapters(id) ON DELETE CASCADE,
    revision    INTEGER NOT NULL,
    text        TEXT NOT NULL
);
