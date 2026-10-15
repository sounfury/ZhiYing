-- 管理员修改过的通用设置与模型专用配置；未写入的键使用应用层默认值。
CREATE TABLE IF NOT EXISTS app_settings (
    setting_group TEXT NOT NULL,
    setting_key TEXT NOT NULL,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    PRIMARY KEY (setting_group, setting_key)
);
