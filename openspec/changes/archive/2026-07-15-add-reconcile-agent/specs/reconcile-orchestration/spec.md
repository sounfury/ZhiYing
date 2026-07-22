## ADDED Requirements

### Requirement: Orchestrator 集成 SuspectsGenerator
Orchestrator._run() 在 CastWriter.finalize() 之后、更新 meta status 之前，SHALL 调用 SuspectsGenerator.generate(cast, ledgers) 生成可疑清单。

#### Scenario: CastWriter 后生成 suspects
- **WHEN** CastWriter.finalize() 完成
- **THEN** 读取合并后的 cast 和全部成功章的 ledger，生成 SuspectList

### Requirement: 可疑清单为空时跳过 Reconcile
当 SuspectList.is_empty == True 且配置 force_reconcile=False 时，Orchestrator SHALL 跳过 Reconcile Agent，直接设置 status=ANALYZED, reconcile_done=True。

#### Scenario: 无可疑项直接完成
- **WHEN** suspects 为空，force_reconcile=False
- **THEN** 不启动 ReconcileAgent，status=ANALYZED, reconcile_done=True

#### Scenario: 无可疑项但强制运行
- **WHEN** suspects 为空，force_reconcile=True
- **THEN** 仍启动 ReconcileAgent

### Requirement: RECONCILING 状态与 SSE
当进入 Reconcile 阶段时，Orchestrator SHALL 将 meta.status 设为 RECONCILING 并推送 SSE 事件 `{"phase": "reconcile_running"}`。

#### Scenario: 进入 reconcile 阶段
- **WHEN** suspects 不为空，准备启动 ReconcileAgent
- **THEN** meta.status=RECONCILING，SSE 推送 progress 事件 phase=reconcile_running

### Requirement: Reconcile 成功后状态
ReconcileAgent 成功提交 patch 且 PatchApplier 成功应用后，Orchestrator SHALL 设置 status=ANALYZED, reconcile_done=True。SSE done 事件 SHALL 包含 `reconcile_done: true`。

#### Scenario: 正常完成校对
- **WHEN** ReconcileAgent 返回有效 patch，PatchApplier 应用成功
- **THEN** status=ANALYZED, reconcile_done=True, SSE done: {reconcile_done: true, ...}

### Requirement: Reconcile 失败降级
当 ReconcileAgent 异常或超时未提交时，Orchestrator SHALL 设置 status=RECONCILE_FAILED, reconcile_done=False。SSE done 事件 SHALL 包含 `reconcile_done: false, degraded: true`。主流程 SHALL NOT 堵塞——ledger + cast 已落盘，Aggregator 仍可出图。

#### Scenario: Agent 超时
- **WHEN** ReconcileAgent 在 max_reconcile_steps 内未提交 submit_reconciliation
- **THEN** status=RECONCILE_FAILED, reconcile_done=False, SSE done: {degraded: true}

#### Scenario: Agent 抛异常
- **WHEN** ReconcileAgent 抛出异常（如 LLM 超时）
- **THEN** status=RECONCILE_FAILED, reconcile_done=False, ledger 和 cast 不受影响

### Requirement: Reconcile 阶段被 stop 中断
当 Orchestrator 在 Reconcile 阶段被 stop 时，SHALL 设 status=RECONCILE_FAILED（与现有 stop 逻辑一致）。

#### Scenario: reconcile 中收到 stop
- **WHEN** ReconcileAgent 运行中收到 stop 请求
- **THEN** status=RECONCILE_FAILED, reconcile_done=False