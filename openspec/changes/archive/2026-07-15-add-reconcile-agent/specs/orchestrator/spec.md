## MODIFIED Requirements

### Requirement: few_long 编排流程
Orchestrator SHALL 实现 few_long 模式编排：(1) 从 chapters 中筛选 `include_in_analysis=true` 的章（可选 `to_chapter` 截断）；(2) 冻结 cast 快照；(3) 使用 `asyncio.Semaphore(max_parallel_chapters)` 并行启动 Chapter Agent；(4) barrier 等待全部完成；(5) CastWriter 顺序 apply；(6) rewrite ledger；(7) SuspectsGenerator 生成可疑清单；(8) 若可疑清单非空或 force_reconcile=True，设置 status=RECONCILING 并运行 ReconcileAgent → PatchApplier；(9) `meta.status` 设为 `analyzed`（成功）或 `reconcile_failed`（降级）。若可疑清单为空且 force_reconcile=False，跳过步骤 (8) 直接设为 `analyzed`。

#### Scenario: 正常全章并行 + 校对
- **WHEN** 书有 5 个 include_in_analysis=true 的章，max_parallel_chapters=5，分析后检测到 2 个可疑项
- **THEN** 5 个 Chapter Agent 并行启动，barrier 后 CastWriter apply，生成 suspects，status=RECONCILING，ReconcileAgent 运行成功后 status=analyzed

#### Scenario: 正常全章并行 + 无可疑跳过
- **WHEN** 书有 5 个分析章，分析后无可疑项，force_reconcile=False
- **THEN** 跳过 ReconcileAgent，status=analyzed, reconcile_done=True

#### Scenario: 并行受 semaphore 限制
- **WHEN** 书有 10 个分析章，max_parallel_chapters=3
- **THEN** 最多 3 个 Agent 同时运行，完成后后续章继续启动

### Requirement: 状态管理
Orchestrator SHALL 在启动时将 `meta.status` 设为 `analyzing`，CastWriter 完成后设为 `reconciling`（若有可疑项），Reconcile 成功后设为 `analyzed`，Reconcile 失败设为 `reconcile_failed`。`analysis_progress` SHALL 更新 chapters_done / chapters_failed 列表及 reconcile_done 字段。

#### Scenario: 分析+校对完成后状态更新
- **WHEN** 5 章全部成功分析，Reconcile 成功
- **THEN** meta.status=analyzed，analysis_progress.chapters_done=[1,2,3,4,5]，reconcile_done=True

#### Scenario: 分析成功但校对失败
- **WHEN** 5 章全部成功分析，ReconcileAgent 异常
- **THEN** meta.status=reconcile_failed，analysis_progress.reconcile_done=False，chapters_done=[1,2,3,4,5]