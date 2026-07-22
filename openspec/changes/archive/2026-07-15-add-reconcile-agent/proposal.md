## Why

CastAtlas 目前已完成「各章并行分析 → CastWriter 合并人名册 + rewrite 临时 id → 检测别名冲突写入 merge_queue.json」的管线，但缺少需求文档 `docs/reconcile-agent-requirements.md` 描述的**全书总校对 Agent**——在程序合并之后的最后一轮 AI 收尾，处理可疑点与有据修正。

当前 `CastWriter._detect_conflicts` 只检测人名合并候选（别名重叠 / 名-别号交叉），无法检测**关系冲突**（同一对人类型硬撞 / 有向方向相反），也没有 Agent 介入做合并裁决和有据修正。

## What Changes

- **可疑清单生成器**（`core/suspects.py`）：从 `CastWriter._detect_conflicts` 抽出公共函数，新增关系冲突检测（读全部 ledger），输出结构化 `SuspectList`
- **Reconcile Agent 运行时**（`agent/reconcile_agent.py`）：同 Chapter Agent 的 LC tool-calling loop，不同 prompt + 工具集 + 步数上限
- **Reconcile 工具集**（在 `agent/tools.py` 中新增 `ReconcileToolContext` + `make_reconcile_tools`）：5 个工具——跨章搜索 / 限量读正文 / 取章分析结果 / 查人名册 / 提交校对结果
- **Reconcile 提示词**（`agent/prompts/reconcile.py`）：system prompt（角色 / 纪律 / 枚举 / 出口）+ user prompt（书信息 / cast / suspects / 各章 summary）
- **校对结果模型**（`models/reconcile.py`）：`ReconcilePatch` / `MergeSuggestion` / `AliasSuggestion` / `RelationChange` / `TodoItem` / `SuspectItem`
- **PatchApplier**（`core/patch_applier.py`）：程序校验 patch → 合并人（rewrite id）→ 加别名 → 改关系（写 overrides）→ 写待办
- **Orchestrator 集成**：`_run()` 尾部在 CastWriter finalize 后插入 suspects 生成 → Reconcile Agent → PatchApplier → 状态更新
- **状态扩展**：`BookStatus` 新增 `RECONCILING` / `RECONCILE_FAILED`；SSE 推送 reconcile 阶段进度
- **配置扩展**：`max_reconcile_steps`（默认 15，低于章分析）、`force_reconcile`（可疑清单为空时是否仍跑一轮）

## Capabilities

### New Capabilities

- `reconcile-suspects`: 可疑清单生成——人名合并候选 + 关系冲突检测，产出结构化 SuspectList
- `reconcile-agent`: 全书总校对 Agent——LC tool-calling loop，处理可疑项，输出结构化 patch
- `reconcile-patch-apply`: 校对结果应用——程序校验 + 合并人 + 改别名 + 改关系(overrides) + 写待办
- `reconcile-orchestration`: 编排集成——在 few_long 管线尾部插入 reconcile 流程 + 降级策略 + SSE

### Modified Capabilities

- `cast-detection`: CastWriter._detect_conflicts 抽出为公共函数 `detect_cast_conflicts(cast)`，CastWriter 调用它
- `book-status`: BookStatus 枚举新增 RECONCILING / RECONCILE_FAILED
- `analysis-progress`: AnalysisProgress 新增 reconcile 相关字段

## Impact

- **新增文件**：
  - `backend/app/core/suspects.py`
  - `backend/app/core/patch_applier.py`
  - `backend/app/agent/reconcile_agent.py`
  - `backend/app/agent/prompts/reconcile.py`
  - `backend/app/models/reconcile.py`
- **修改文件**：
  - `backend/app/agent/tools.py` — 新增 ReconcileToolContext + make_reconcile_tools
  - `backend/app/agent/cast_writer.py` — 抽出 _detect_conflicts 为公共函数
  - `backend/app/core/orchestrator.py` — _run() 尾部插入 reconcile 流程
  - `backend/app/models/book.py` — BookStatus 新增 RECONCILING / RECONCILE_FAILED
  - `backend/app/config.py` — 新增 max_reconcile_steps / force_reconcile
  - `backend/app/storage/filestore.py` — 新增 overrides 读写方法
- **不涉及**：前端改动（P0 先跑通后端管线）、NLP Cast Pass（P1）、Memory/波次（P1）