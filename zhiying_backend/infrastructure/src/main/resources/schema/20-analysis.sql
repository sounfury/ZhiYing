-- 分析编排存储：任务快照、各章执行状态、书的分析状态，以及按章保存的抽取记录。
-- 不对书与章节表建外键：这里只按 book_id / chapter_id 关联，书与章节由 library 模块的脚本维护。
-- 任务快照整体覆盖更新；章抽取记录一经写入不再修改，重跑产生新记录，当前指针指向最新一条。
CREATE TABLE IF NOT EXISTS analysis_task (
    task_id        TEXT PRIMARY KEY,
    book_id        TEXT NOT NULL,
    kind           TEXT NOT NULL,            -- FULL 整书分析 / RERUN 单章重跑
    status         TEXT NOT NULL,            -- RUNNING / COMPLETED / FAILED / CANCELLED
    phase          TEXT NOT NULL,            -- 仅作进度信息
    started_at     TEXT NOT NULL,            -- ISO-8601 UTC 时间
    finished_at    TEXT,
    revision_id    TEXT,                     -- 本任务发布的结果版本，未发布为空
    message        TEXT,                     -- 终态说明：失败 / 取消原因，或完成备注
    requests       INTEGER NOT NULL DEFAULT 0,
    input_tokens   INTEGER NOT NULL DEFAULT 0,
    output_tokens  INTEGER NOT NULL DEFAULT 0,
    total_tokens   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_analysis_task_book ON analysis_task (book_id, started_at);

CREATE TABLE IF NOT EXISTS analysis_task_chapter (
    task_id      TEXT NOT NULL REFERENCES analysis_task (task_id) ON DELETE CASCADE,
    chapter_id   TEXT NOT NULL,
    ord          INTEGER NOT NULL,           -- 阅读序号
    title        TEXT NOT NULL,
    status       TEXT NOT NULL,              -- PENDING / RUNNING / DONE / REUSED / FAILED / CANCELLED
    units_total  INTEGER NOT NULL,           -- 阅读单元数（长章切段）
    units_done   INTEGER NOT NULL,
    error        TEXT,                       -- 失败原因
    warnings     TEXT NOT NULL DEFAULT '[]', -- 读章警告，JSON 数组
    PRIMARY KEY (task_id, chapter_id)
);

-- 书的分析状态（供书库列表展示）：只反映最近一次整书任务，单章重跑不改写。
CREATE TABLE IF NOT EXISTS book_analysis (
    book_id         TEXT PRIMARY KEY,
    task_id         TEXT NOT NULL,
    status          TEXT NOT NULL,           -- ANALYZING / ANALYZED / FAILED / CANCELLED
    total_chapters  INTEGER NOT NULL,
    done_orders     TEXT NOT NULL,           -- 已有抽取的章序号，JSON 数组
    failed_orders   TEXT NOT NULL,           -- 失败章序号，JSON 数组
    updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chapter_extraction (
    extraction_id   TEXT PRIMARY KEY,
    book_id         TEXT NOT NULL,
    chapter_id      TEXT NOT NULL,
    task_id         TEXT NOT NULL,
    format_version  INTEGER NOT NULL,
    text_revision   INTEGER NOT NULL,        -- 抽取所依据的正文修订
    model           TEXT NOT NULL,
    prompt_version  TEXT NOT NULL,
    warnings        TEXT NOT NULL,           -- JSON 数组
    payload         TEXT NOT NULL,           -- 抽取内容整体序列化的 JSON
    created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chapter_extraction_chapter ON chapter_extraction (chapter_id);

CREATE TABLE IF NOT EXISTS chapter_extraction_current (
    chapter_id     TEXT PRIMARY KEY,
    book_id        TEXT NOT NULL,
    extraction_id  TEXT NOT NULL REFERENCES chapter_extraction (extraction_id)
);

CREATE INDEX IF NOT EXISTS idx_chapter_extraction_current_book ON chapter_extraction_current (book_id);
