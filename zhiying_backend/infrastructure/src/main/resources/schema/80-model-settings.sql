-- 后台仅覆盖三个分析环节的模型名和思考开关，空模型名使用部署默认模型。
CREATE TABLE IF NOT EXISTS model_settings (
    call_point TEXT PRIMARY KEY CHECK (call_point IN ('READING', 'POST_PROCESS', 'AFFILIATION')),
    model TEXT NOT NULL,
    thinking INTEGER NOT NULL CHECK (thinking IN (0, 1)),
    updated_at TEXT NOT NULL,
    updated_by TEXT NOT NULL REFERENCES accounts(id)
);
