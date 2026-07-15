## ADDED Requirements

### Requirement: Analysis routes registration
`main.py` SHALL 注册 analysis router（`api/analysis.py`），替换现有的 501 stub 端点（/analyze, /progress, /analyze/stop, /cast, /chapters/{cid}/result 中的相关路由）。GET /api/meta/relation-types 和 GET /api/health 保持不变。

#### Scenario: 路由注册后可访问
- **WHEN** FastAPI app 启动后请求 POST /api/books/{id}/analyze
- **THEN** 不再返回 501，而是执行分析逻辑或返回 404/409/202

### Requirement: BookMeta status 更新
分析启动时系统 SHALL 将 `meta.status` 更新为 `analyzing` 并写入 `meta.json`。分析完成后更新为 `analyzed`（或全部失败时 `failed`）。`analysis_progress.mode` SHALL 设为 `few_long`，`chapters_done` 和 `chapters_failed` SHALL 反映实际结果。

#### Scenario: 启动分析时更新状态
- **WHEN** Orchestrator 启动分析
- **THEN** meta.json 中 status 变为 "analyzing"，analysis_progress.mode 变为 "few_long"

#### Scenario: 分析完成后更新状态
- **WHEN** 5 章全部成功分析
- **THEN** meta.json 中 status 变为 "analyzed"，chapters_done=[1,2,3,4,5]，chapters_failed=[]
