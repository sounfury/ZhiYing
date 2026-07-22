## ADDED Requirements

### Requirement: Reconcile Agent tool-calling loop
系统 SHALL 使用 LangChain tool-calling 运行 Reconcile Agent，循环执行「LLM 决策 → 工具调用 → 结果加入上下文」直到模型调用 `submit_reconciliation` 或达到 `max_reconcile_steps` 上限。`max_reconcile_steps` 默认 15（低于章分析的 20），可通过配置 `MAX_RECONCILE_STEPS` 覆盖。

#### Scenario: 正常提交退出
- **WHEN** Agent 在第 8 步调用 submit_reconciliation 且校验通过
- **THEN** 循环退出，返回 ReconcilePatch

#### Scenario: 达到步数上限未提交
- **WHEN** Agent 在 max_reconcile_steps=15 步内未调用 submit_reconciliation
- **THAN** 循环退出，返回 success=False，warning="Did not submit within 15 steps"

### Requirement: Reconcile Agent system prompt
系统 SHALL 构建 Reconcile Agent 的 system prompt，包含：(1) 角色描述（全书总校对 Agent）；(2) 纪律约束（不重做全书分析、没把握写待办、合并改关系带章号+原句、禁止无证据重写）；(3) 可用工具列表及说明；(4) 关系类型枚举（复用 `relation_summary_for_prompt()`）；(5) 出口约定（submit_reconciliation 的 patch 格式与校验规则）。

#### Scenario: system prompt 包含关系枚举
- **WHEN** 构建 Reconcile system prompt
- **THEN** prompt 文本中包含全部 12 个关系类型名（夫妻/亲子/兄妹/...）及其 tier 和有向/无向标注

### Requirement: Reconcile Agent user prompt
系统 SHALL 构建 Reconcile Agent 的 user prompt，注入：(1) 书名与分析章范围；(2) 合并后的 cast 摘要；(3) 可疑清单全文（cast_conflicts / relation_conflicts / missing_evidence，每项带详细信息）；(4) 各章 summary 文本。

#### Scenario: 注入可疑清单
- **WHEN** suspects 有 2 个 cast_conflicts 和 1 个 relation_conflict
- **THEN** user prompt 中包含"可能是同一个人（2 项）"和"关系冲突（1 项）"段落，每项列出 person_id / reason / chapters 等

#### Scenario: 空可疑清单不调用 Agent
- **WHEN** SuspectList.is_empty == True 且 force_reconcile=False
- **THEN** 不构建 user prompt，不启动 ReconcileAgent

### Requirement: Reconcile Agent 使用独立模型配置
系统 SHALL 使用 `get_reconcile_llm()` 创建 Reconcile Agent 的 ChatModel。模型配置 `LLM_RECONCILE_MODEL` 不为空时使用该模型，否则回退到主模型 `LLM_MODEL`。

#### Scenario: 配置了独立模型
- **WHEN** LLM_RECONCILE_MODEL="gpt-4o-mini"
- **THEN** ReconcileAgent 使用 gpt-4o-mini

#### Scenario: 未配置独立模型回退主模型
- **WHEN** LLM_RECONCILE_MODEL 为空
- **THEN** ReconcileAgent 回退使用 LLM_MODEL