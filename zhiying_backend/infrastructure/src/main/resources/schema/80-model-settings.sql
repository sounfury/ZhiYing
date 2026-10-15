-- 后台维护的 OpenAI 兼容服务商；分析环节的选择保存在 app_settings 的 model 组。

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
