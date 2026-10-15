-- 后台为三个分析环节选择服务商、模型名和思考开关，空模型名使用部署默认模型；provider_id 为 default 表示部署配置的服务商。
CREATE TABLE IF NOT EXISTS model_settings (
    call_point TEXT PRIMARY KEY CHECK (call_point IN ('READING', 'POST_PROCESS', 'AFFILIATION')),
    provider_id TEXT NOT NULL DEFAULT 'default',
    model TEXT NOT NULL,
    thinking INTEGER NOT NULL CHECK (thinking IN (0, 1)),
    updated_at TEXT NOT NULL,
    updated_by TEXT NOT NULL REFERENCES accounts(id)
);

-- 后台新增的 OpenAI 兼容服务商；密钥用 zhiying.llm.secret-key 加密（AES-GCM），只存末尾几位明文供界面识别。
CREATE TABLE IF NOT EXISTS model_providers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    api_key_cipher TEXT NOT NULL,
    key_hint TEXT NOT NULL,
    thinking_style TEXT NOT NULL CHECK (thinking_style IN ('DEEPSEEK', 'ENABLE_THINKING', 'NONE')),
    updated_at TEXT NOT NULL,
    updated_by TEXT NOT NULL REFERENCES accounts(id)
);
