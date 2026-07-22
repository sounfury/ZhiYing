## ADDED Requirements

### Requirement: BookStatus 新增 RECONCILING
BookStatus 枚举 SHALL 新增 `RECONCILING = "reconciling"` 状态值，表示全书总校对 Agent 正在运行。

#### Scenario: 进入校对状态
- **WHEN** Orchestrator 完成 CastWriter 后检测到可疑项，准备运行 ReconcileAgent
- **THEN** meta.status = "reconciling"

### Requirement: BookStatus 新增 RECONCILE_FAILED
BookStatus 枚举 SHALL 新增 `RECONCILE_FAILED = "reconcile_failed"` 状态值，表示总校对失败但分析数据完整可用（可出图降级）。

#### Scenario: 校对失败
- **WHEN** ReconcileAgent 异常或超时
- **THEN** meta.status = "reconcile_failed"

#### Scenario: 降级可出图
- **WHEN** status = "reconcile_failed"，前端请求 GET /graph
- **THEN** Aggregator 正常返回图数据（只读 ledger + overrides，不依赖 reconcile 结果）

### Requirement: AnalysisProgress reconcile_done 字段
AnalysisProgress SHALL 包含 `reconcile_done: bool` 字段（默认 False）。当 Reconcile Agent 成功完成且 patch 应用后设为 True；跳过 reconcile（suspects 为空）时也设为 True；reconcile 失败时保持 False。

#### Scenario: 正常完成校对
- **WHEN** ReconcileAgent 成功，patch 已应用
- **THEN** analysis_progress.reconcile_done = True

#### Scenario: 跳过校对
- **WHEN** suspects 为空，跳过 ReconcileAgent
- **THEN** analysis_progress.reconcile_done = True

#### Scenario: 校对失败
- **WHEN** ReconcileAgent 失败
- **THEN** analysis_progress.reconcile_done = False

### Requirement: ReconcilePatch 数据模型
系统 SHALL 定义 ReconcilePatch Pydantic 模型，包含四个列表字段：`merges: list[MergeSuggestion]`、`aliases: list[AliasSuggestion]`、`relation_changes: list[RelationChange]`、`todos: list[TodoItem]`。

#### Scenario: 空 patch
- **WHEN** ReconcilePatch 未传任何字段
- **THEN** 四个列表均为空 `[]`

### Requirement: SuspectList 数据模型
系统 SHALL 定义 SuspectList Pydantic 模型，包含 `cast_conflicts: list[CastConflict]`、`relation_conflicts: list[RelationConflict]`、`missing_evidence: list[MissingEvidence]`。SHALL 提供 `is_empty` 属性，当三个列表均为空时返回 True。

#### Scenario: 判空
- **WHEN** SuspectList 三个字段均为空列表
- **THEN** is_empty == True