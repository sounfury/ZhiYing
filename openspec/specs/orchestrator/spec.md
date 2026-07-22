## ADDED Requirements

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

### Requirement: to_chapter 截断
`POST /analyze?to_chapter=N` 传入时，Orchestrator SHALL 只调度 `chapter.order ≤ N 且 include_in_analysis=true` 的章。不传 `to_chapter` 时调度全部 `include_in_analysis=true` 的章。

#### Scenario: 传了 to_chapter
- **WHEN** 书有 20 章，include_in_analysis=true 的有 15 章（order 1-15），to_chapter=10
- **THEN** 只调度 order ≤ 10 的章

#### Scenario: 未传 to_chapter
- **WHEN** 书有 15 个 include_in_analysis=true 的章，未传 to_chapter
- **THEN** 调度全部 15 章

### Requirement: 防重入
当 `meta.status` 为 `analyzing` 或 `reconciling` 时，Orchestrator SHALL 拒绝启动新分析，返回 409 `ANALYSIS_ALREADY_RUNNING`。

#### Scenario: 分析中再次请求
- **WHEN** 书 status=analyzing，再次 POST /analyze
- **THEN** 返回 409 错误，code=ANALYSIS_ALREADY_RUNNING

#### Scenario: 校对中再次请求
- **WHEN** 书 status=reconciling，再次 POST /analyze
- **THEN** 返回 409 错误，code=ANALYSIS_ALREADY_RUNNING

### Requirement: 粗糙 stop flag
Orchestrator SHALL 维护一个 `asyncio.Event` stop flag。`POST /analyze/stop` set 该 flag。尚未启动的 Agent SHALL 检查 flag 并跳过；已启动的 Agent 等其自然完成后 status 标记为 `failed`。

#### Scenario: Stop 中断未启动的章
- **WHEN** 10 章中 3 章已完成，2 章在运行，5 章未启动；收到 stop 请求
- **THEN** 运行中的 2 章完成后自然结束；未启动的 5 章跳过；status 设为 `failed`（或保持 `analyzing` 直到用户手动重置）

### Requirement: 单章失败不阻塞全局
任一 Chapter Agent 失败时，Orchestrator SHALL 记录失败章 id 并继续其他章。最终 status 仍可为 `analyzed`（部分章失败记录在 `analysis_progress.chapters_failed` 中）。

#### Scenario: 一章失败其余成功
- **WHEN** 5 章中 ch3 的 Agent 失败（如 LLM 超时），其余 4 章成功
- **THEN** ch3 记入 chapters_failed；CastWriter 只 apply 成功章的 cast_ops；status=analyzed；SSE 推送 ch3 失败事件

### Requirement: 状态管理
Orchestrator SHALL 在启动时将 `meta.status` 设为 `analyzing`，CastWriter 完成后设为 `reconciling`（若有可疑项），Reconcile 成功后设为 `analyzed`，Reconcile 失败设为 `reconcile_failed`。`analysis_progress` SHALL 更新 chapters_done / chapters_failed 列表及 reconcile_done 字段。

#### Scenario: 分析+校对完成后状态更新
- **WHEN** 5 章全部成功分析，Reconcile 成功
- **THEN** meta.status=analyzed，analysis_progress.chapters_done=[1,2,3,4,5]，reconcile_done=True

#### Scenario: 分析成功但校对失败
- **WHEN** 5 章全部成功分析，ReconcileAgent 异常
- **THEN** meta.status=reconcile_failed，analysis_progress.reconcile_done=False，chapters_done=[1,2,3,4,5]
