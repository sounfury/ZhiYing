-- 类型语义决策缓存：键是 TypeSemanticKey.text（含策略版本与类型库指纹），值是 TypeDecision 的 JSON。
-- 与具体候选、人物、章节无关；类型库或策略变化后键自然不同，旧行不再命中，无需清理。
CREATE TABLE IF NOT EXISTS type_decision_cache (
    cache_key   TEXT PRIMARY KEY,
    payload     TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
