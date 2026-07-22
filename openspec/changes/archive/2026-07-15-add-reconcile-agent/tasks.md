# Implementation Tasks

## Phase 1: Data Models & Infrastructure

- [x] 1.1 `models/reconcile.py` — 定义 CastConflict / RelationConflict / MissingEvidence / SuspectList / MergeSuggestion / AliasSuggestion / RelationChange / TodoItem / ReconcilePatch / PatchApplyResult
- [x] 1.2 `models/book.py` — BookStatus 新增 RECONCILING / RECONCILE_FAILED
- [x] 1.3 `config.py` — 新增 max_reconcile_steps / force_reconcile
- [x] 1.4 `storage/filestore.py` — 新增 read_relation_overrides / write_relation_overrides / write_todo_list / write_reconcile_report

## Phase 2: Suspects Generator

- [x] 2.1 `core/suspects.py` — detect_cast_conflicts（从 CastWriter._detect_conflicts 抽出）
- [x] 2.2 `core/suspects.py` — detect_relation_conflicts（新增，读全部 ledger 检测 type_clash / direction_clash）
- [x] 2.3 `core/suspects.py` — detect_missing_evidence（新增，hard 边缺 quote）
- [x] 2.4 `core/suspects.py` — SuspectsGenerator 类（组合以上三个 + is_empty）
- [x] 2.5 `agent/cast_writer.py` — _detect_conflicts 改为调用 detect_cast_conflicts

## Phase 3: Reconcile Agent Tools & Prompt

- [x] 3.1 `agent/tools.py` — ReconcileToolContext 上下文类
- [x] 3.2 `agent/tools.py` — make_reconcile_tools: search_in_chapter
- [x] 3.3 `agent/tools.py` — make_reconcile_tools: read_chapter_text
- [x] 3.4 `agent/tools.py` — make_reconcile_tools: get_chapter_result
- [x] 3.5 `agent/tools.py` — make_reconcile_tools: query_cast（复用逻辑）
- [x] 3.6 `agent/tools.py` — make_reconcile_tools: submit_reconciliation（含校验）
- [x] 3.7 `agent/prompts/reconcile.py` — build_system_prompt + build_user_prompt

## Phase 4: Reconcile Agent Runtime

- [x] 4.1 `agent/reconcile_agent.py` — run_reconcile_agent 函数（LC tool-calling loop）
- [x] 4.2 复用现有 llm.py 的 get_reconcile_llm（已实现）

## Phase 5: Patch Applier

- [x] 5.1 `core/patch_applier.py` — _apply_merges（rewrite person_id 全库）
- [x] 5.2 `core/patch_applier.py` — _apply_aliases（更新 cast）
- [x] 5.3 `core/patch_applier.py` — _apply_relation_changes（写 overrides）
- [x] 5.4 `core/patch_applier.py` — _apply_todos（写 todo_list.json）
- [x] 5.5 `core/patch_applier.py` — apply() 主方法 + 写 reconcile_report.json

## Phase 6: Orchestrator Integration

- [x] 6.1 `core/orchestrator.py` — _run() CastWriter 后插入 SuspectsGenerator
- [x] 6.2 `core/orchestrator.py` — suspects 为空时的跳过逻辑
- [x] 6.3 `core/orchestrator.py` — RECONCILING 状态 + SSE reconcile_running
- [x] 6.4 `core/orchestrator.py` — ReconcileAgent 调用 + PatchApplier
- [x] 6.5 `core/orchestrator.py` — RECONCILE_FAILED 降级路径
- [x] 6.6 `core/orchestrator.py` — SSE done 事件含 reconcile_done / degraded 字段

## Phase 7: Testing

- [x] 7.1 单元测试：detect_cast_conflicts / detect_relation_conflicts
- [x] 7.2 单元测试：submit_reconciliation 校验逻辑
- [x] 7.3 单元测试：PatchApplier（merges / aliases / relation_changes / todos）
- [x] 7.4 集成测试：Orchestrator 完整管线（suspects → reconcile → patch → ANALYZED）
- [x] 7.5 集成测试：Reconcile 失败降级（RECONCILE_FAILED → 仍可出图）
- [x] 7.6 集成测试：suspects 为空跳过 reconcile