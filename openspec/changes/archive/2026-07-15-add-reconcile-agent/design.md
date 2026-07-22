# Reconcile Agent 设计草案

> 依据：`docs/reconcile-agent-requirements.md` + `docs/ARCHITECTURE.md` §4.6.2  
> 状态：草案（实现前可改）

---

## 1. 管线位置与状态流转

```
各章并行分析（ChapterAgent）         ← 已实现
  → CastWriter 合并人名册 + rewrite   ← 已实现
  → SuspectsGenerator 生成可疑清单     ← 新建
  → [可疑清单为空?]
      ├─ Yes + force_reconcile=false → 直接 ANALYZED, reconcile_done=true
      ├─ Yes + force_reconcile=true  → ↓
      └─ No                          → ↓
  → status=RECONCILING, SSE: reconcile_running
  → ReconcileAgent.run()              ← 新建
  → [Agent 成功?]
      ├─ Yes → PatchApplier.apply()   ← 新建
      │        → status=ANALYZED, reconcile_done=true
      │        → SSE: done (reconcile_done=true)
      └─ No  → status=RECONCILE_FAILED
               → SSE: done (reconcile_done=false, degraded=true)
               → 仍可出图（Aggregator 只读 ledger + overrides）
```

### 状态机变化

```
原:  ANALYZING → ANALYZED | FAILED

新:  ANALYZING
       → (CastWriter done)
       → RECONCILING
       → ANALYZED (reconcile_done=true)
       | RECONCILE_FAILED (reconcile_done=false, 仍可出图)
       | ANALYZED (suspects 为空, 跳过 reconcile, reconcile_done=true)
```

`RECONCILE_FAILED` 语义：分析数据完整可用（ledger + cast 已落盘），只是未做总校对。前端出图不受影响；可显示「未校对」提示。

---

## 2. 模块划分与职责

```
┌─────────────────────────────────────────────────────────────────┐
│                      Orchestrator._run()                        │
│                                                                 │
│  ... (现有: 并行章分析 → CastWriter) ...                        │
│                                                                 │
│  ┌─────────────────────────────────────────┐                   │
│  │ SuspectsGenerator                        │                   │
│  │  · detect_cast_conflicts(cast)           │  ← 抽自 CastWriter│
│  │  · detect_relation_conflicts(ledgers)    │  ← 新增           │
│  │  · detect_missing_evidence(ledgers)      │  ← 可选(P0 做)    │
│  │  → SuspectList                           │                   │
│  └────────────────┬────────────────────────┘                   │
│                   │                                             │
│         suspects 为空且不强制?                                   │
│           ├─ Yes → skip                                         │
│           └─ No  ↓                                              │
│  ┌─────────────────────────────────────────┐                   │
│  │ ReconcileAgent.run()                     │                   │
│  │  · system prompt (角色/纪律/枚举/出口)    │                   │
│  │  · user prompt (cast+suspects+summaries) │                   │
│  │  · tool-calling loop (max_reconcile_steps)│                  │
│  │  → ReconcilePatch                        │                   │
│  └────────────────┬────────────────────────┘                   │
│                   │                                             │
│  ┌─────────────────────────────────────────┐                   │
│  │ PatchApplier.apply(patch)                │                   │
│  │  1. 校验 patch 合法性                     │                   │
│  │  2. merges → rewrite person_id 全库       │                   │
│  │  3. aliases → 更新 cast                   │                   │
│  │  4. relation_changes → 写 overrides       │                   │
│  │  5. todos → 写 todo_list.json             │                   │
│  └─────────────────────────────────────────┘                   │
└─────────────────────────────────────────────────────────────────┘
```

---

## 3. 可疑清单生成（SuspectsGenerator）

### 3.1 人名冲突检测（抽自 CastWriter）

从 `CastWriter._detect_conflicts` 抽出为模块级函数：

```python
# core/suspects.py

def detect_cast_conflicts(cast: Cast) -> list[CastConflict]:
    """
    检测人名合并候选（原 CastWriter._detect_conflicts 逻辑）。

    规则：
      - alias_overlap: 两人的别名集合有交集
      - name_alias_cross: A 的正式名 = B 的某个别名（或反之）
    """
```

`CastWriter._detect_conflicts` 改为调用此函数。

### 3.2 关系冲突检测（新增）

```python
def detect_relation_conflicts(
    ledgers: list[ChapterLedger],
) -> list[RelationConflict]:
    """
    扫描全部 ledger，检测同一对人之间的关系冲突。

    冲突类型：
      1. type_clash: 同一对人（无向），不同章给了不同 type，且均为 hard
         例: ch3 (p001,p005,表亲) vs ch5 (p001,p005,夫妻)
      2. direction_clash: 有向关系，同一对人对同一 type 方向相反
         例: ch3 (p001→p002,师徒) vs ch5 (p002→p001,师徒)
         （P0 可只报告不强判，交给 Agent 裁决）
    """
```

实现要点：
- 汇总键：无向 `(min_id, max_id)`；有向 `(from_id, to_id)`
- 按 pair 分组所有 ledger 关系，检测组内冲突
- 输出附带 chapter_ids，让 Agent 知道去哪些章查原文

### 3.3 可选：hard 边缺证据（P0 做，轻量）

```python
def detect_missing_evidence(
    ledgers: list[ChapterLedger],
) -> list[MissingEvidence]:
    """
    hard 关系但 quote 为空 → 标记「去查一下」。
    不阻塞，只作提示。
    """
```

### 3.4 SuspectList 数据结构

```python
# models/reconcile.py

class CastConflict(BaseModel):
    person_a_id: str
    person_b_id: str
    reason: str          # "alias_overlap" | "name_alias_cross"
    aliases_overlap: list[str]

class RelationConflict(BaseModel):
    person_a: str
    person_b: str
    conflict_type: str   # "type_clash" | "direction_clash"
    details: str         # 人可读描述
    chapters: list[int]  # 涉及哪些章

class MissingEvidence(BaseModel):
    person_a: str
    person_b: str
    type: str
    chapter_id: int

class SuspectList(BaseModel):
    cast_conflicts: list[CastConflict]
    relation_conflicts: list[RelationConflict]
    missing_evidence: list[MissingEvidence]

    @property
    def is_empty(self) -> bool:
        return (
            not self.cast_conflicts
            and not self.relation_conflicts
            and not self.missing_evidence
        )
```

---

## 4. Reconcile Agent 工具集

在 `agent/tools.py` 中新增 `ReconcileToolContext` + `make_reconcile_tools`，与 ChapterAgent 工具共存于同一文件。

### 4.1 ReconcileToolContext

```python
@dataclass
class ReconcileToolContext:
    """Reconcile Agent 运行时上下文。"""
    book_id: str
    cast: Cast                           # 合并后的最终 cast（只读）
    suspects: SuspectList                # 可疑清单
    chapter_summaries: dict[int, str]   # {chapter_id: summary}
    filestore: Filestore
    submit_patch: ReconcilePatch | None = None  # submit_reconciliation 写入
```

### 4.2 五个工具

| # | 工具名 | 参数 | 说明 |
|---|--------|------|------|
| 1 | `search_in_chapter` | `chapter_id: int, keyword: str` | 在**指定章**搜关键词，返回命中行（上限 50 条）。与 ChapterAgent 的 grep_in_chapter 相似但带 chapter_id 参数。 |
| 2 | `read_chapter_text` | `chapter_id: int, offset: int, limit: int` | 读**指定章**的字符窗口。limit 上限复用 `read_window_chars`。 |
| 3 | `get_chapter_result` | `chapter_id: int` | 查看该章 ledger（persons + relations + summary）。只读。 |
| 4 | `query_cast` | `()` | 查询当前 cast（合并后最终版）。只读。 |
| 5 | `submit_reconciliation` | `merges, aliases, relation_changes, todos` | **唯一出口**：提交结构化 patch。校验失败返回错误字符串。 |

### 4.3 与 ChapterAgent 工具的对比

```
┌───────────────────┬──────────────────────┬────────────────────────────┐
│ 能力               │ ChapterAgent          │ ReconcileAgent             │
├───────────────────┼──────────────────────┼────────────────────────────┤
│ 搜索               │ grep_in_chapter(kw)   │ search_in_chapter(ch_id,kw)│
│ 读正文             │ read_chapter_window   │ read_chapter_text(ch_id,…)  │
│ 查人名册           │ query_cast()          │ query_cast()  (相同)        │
│ 查章结果           │ —                     │ get_chapter_result(ch_id)   │
│ 提议新人           │ propose_cast_update   │ — (不提议新人)               │
│ 提交               │ submit_result(...)    │ submit_reconciliation(...)  │
└───────────────────┴──────────────────────┴────────────────────────────┘
```

复用策略：
- `query_cast` 逻辑可直接复用（只是读的 cast 来源不同）
- `search_in_chapter` / `read_chapter_text` 与 ChapterAgent 版本相似但多了 `chapter_id` 参数
- 不用继承/混入，直接在 `make_reconcile_tools` 中闭包实现，保持简单

### 4.4 submit_reconciliation 校验逻辑

```python
@tool
def submit_reconciliation(
    merges: list[dict],
    aliases: list[dict],
    relation_changes: list[dict],
    todos: list[dict],
) -> str:
    """
    校验规则：
      merges:
        - keep_id / drop_id 必须在 cast 中存在
        - keep_id != drop_id
      aliases:
        - person_id 必须在 cast 中存在
        - new_aliases 不为空
      relation_changes:
        - action ∈ {"add", "remove"}
        - person_a / person_b 必须在 cast 中存在
        - type 必须在 RELATION_TYPES 枚举内
        - add 需要 chapter_id + 符合 Relation 构造规则
        - remove 需要 chapter_id + 足够定位信息
      todos:
        - description 不为空

    校验失败 → 返回 {status: "error", message: "..."} 让模型改
    校验通过 → 写入 ctx.submit_patch，返回 {status: "submitted"}
    """
```

---

## 5. Reconcile Prompt

### 5.1 System Prompt 骨架

```
你是一名全书总校对 Agent。你的任务是根据可疑清单，利用工具回查原文，
做出合并 / 修正 / 待办决策，以结构化 patch 提交结果。

## 纪律

- 不重做全书分析，只处理可疑点与有据修正
- 没把握的写入待办(todos)，不要硬改
- 合并与改关系尽量带章号 + 原句
- 禁止无证据重写整本人名册或关系网

## 可用工具

1. search_in_chapter(chapter_id, keyword) — 在指定章搜关键词
2. read_chapter_text(chapter_id, offset, limit) — 读指定章的字符窗口
3. get_chapter_result(chapter_id) — 查看该章分析结果
4. query_cast() — 查询最终人名册
5. submit_reconciliation(merges, aliases, relation_changes, todos) — 提交校对结果

## 关系类型枚举

{relation_summary}

## 出口约定

submit_reconciliation 的 patch 格式：
  merges: [{keep_id, drop_id, reason, evidence}]
  aliases: [{person_id, new_aliases, reason}]
  relation_changes: [{action: "add"|"remove", person_a, person_b, type, chapter_id, quote?, note?}]
  todos: [{description, person_ids?, chapter_ids?}]

校验失败会返回错误字符串，修正后重新提交。
```

### 5.2 User Prompt 骨架

```
## 书籍信息
- 书名: {title}
- 分析章范围: {chapters_done}

## 人名册（合并后，共 {n} 人）
{cast_summary}

## 可疑清单

### 可能是同一个人（{n} 项）
{cast_conflicts_text}

### 关系冲突（{n} 项）
{relation_conflicts_text}

### 缺少证据（{n} 项）
{missing_evidence_text}

## 各章摘要
{chapter_summaries_text}

## 任务
请逐项处理可疑清单。对每项：
1. 先用工具回查原文（search_in_chapter / read_chapter_text / get_chapter_result）
2. 做出决策：合并 / 改别名 / 改关系 / 写待办
3. 全部处理完后，用 submit_reconciliation 一次性提交。
```

---

## 6. ReconcilePatch 数据模型

```python
# models/reconcile.py

class MergeSuggestion(BaseModel):
    keep_id: str
    drop_id: str
    reason: str
    evidence: str = ""          # 章号 + 原句

class AliasSuggestion(BaseModel):
    person_id: str
    new_aliases: list[str]
    reason: str = ""

class RelationChange(BaseModel):
    action: str                 # "add" | "remove"
    person_a: str
    person_b: str
    type: str
    chapter_id: int
    quote: str = ""
    note: str = ""

class TodoItem(BaseModel):
    description: str
    person_ids: list[str] = []
    chapter_ids: list[int] = []

class ReconcilePatch(BaseModel):
    merges: list[MergeSuggestion] = []
    aliases: list[AliasSuggestion] = []
    relation_changes: list[RelationChange] = []
    todos: list[TodoItem] = []
```

---

## 7. PatchApplier

```python
# core/patch_applier.py

class PatchApplier:
    """
    应用 ReconcilePatch 到存储层。

    应用顺序（需求文档 §6）：
      1. merges → rewrite person_id 全库（cast + ledger + overrides）
      2. aliases → 更新 cast
      3. relation_changes → 写 overrides/relation_overrides.json
      4. todos → 写 todo_list.json
    """

    def __init__(self, book_id: str, filestore: Filestore):
        self.book_id = book_id
        self.filestore = filestore

    def apply(self, patch: ReconcilePatch) -> PatchApplyResult:
        """应用 patch，返回结果摘要。"""
        # 1. merges
        id_remap = self._apply_merges(patch.merges)

        # 2. aliases (在 merge 之后，因为 merge 可能改了 person_id)
        self._apply_aliases(patch.aliases, id_remap)

        # 3. relation_changes
        self._apply_relation_changes(patch.relation_changes, id_remap)

        # 4. todos
        self._apply_todos(patch.todos)

        # bump cast version
        return PatchApplyResult(
            merges_applied=len(patch.merges),
            aliases_applied=len(patch.aliases),
            relation_changes_applied=len(patch.relation_changes),
            todos_written=len(patch.todos),
        )
```

### 7.1 合并实现（复用现有逻辑）

`_apply_merges` 本质等价于 ARCHITECTURE §8.2 的 `POST /cast/merge`：

```
for each merge in patch.merges:
  1. cast: drop 的别名并入 keep；删除 drop person
  2. 扫全部 ledger: drop_id → keep_id
  3. 扫 overrides: drop_id → keep_id
  4. 自环边丢弃；重复 (a,b,type) 合并证据
```

这部分逻辑可以从 CastWriter 的 `_rewrite_ledgers` 中抽取模式，或直接在这里实现。
P0 选择直接实现（代码量不大，且 merge 语义与 CastWriter 的 rewrite 略有不同——CastWriter 是临时→正式，这里是正式→正式）。

### 7.2 关系修改落地

```
relation_changes → overrides/relation_overrides.json
  add  → overrides["add"].append(...)
  remove → overrides["remove"].append(...)
```

与 ARCHITECTURE §8.1 的人工 override 完全相同的格式和机制。Aggregator 汇总时先读 ledger → apply overrides。

### 7.3 待办落地

```
todos → workspace/{book_id}/todo_list.json
[
  {"description": "...", "person_ids": [...], "chapter_ids": [...]}
]
```

---

## 8. Orchestrator 集成

### 8.1 _run() 尾部插入

在现有 `_run()` 的 CastWriter finalize 之后、更新 meta status 之前：

```python
# ── CastWriter finalize (existing) ──
await asyncio.to_thread(cast_writer.finalize)

# ── 生成可疑清单 ──
cast = filestore.read_cast(book_id)
ledgers = filestore.read_ledgers(book_id, chapters_done)
suspects = SuspectsGenerator().generate(cast, ledgers)

# ── 是否跳过 ──
if suspects.is_empty and not cfg.force_reconcile:
    self._meta.status = BookStatus.ANALYZED
    self._meta.analysis_progress.reconcile_done = True
    # → push done, finalize
else:
    # ── 状态 → RECONCILING ──
    self._meta.status = BookStatus.RECONCILING
    await asyncio.to_thread(filestore.write_meta, book_id, self._meta)
    await self.progress_queue.put({"type": "progress", "data": {"phase": "reconcile_running"}})

    # ── 运行 ReconcileAgent ──
    try:
        chapter_summaries = {l.chapter_id: l.summary for l in ledgers}
        patch = await run_reconcile_agent(
            book_id, cast, suspects, chapter_summaries, filestore, cfg
        )

        # ── 应用 patch ──
        applier = PatchApplier(book_id, filestore)
        apply_result = await asyncio.to_thread(applier.apply, patch)

        self._meta.status = BookStatus.ANALYZED
        self._meta.analysis_progress.reconcile_done = True

    except Exception as e:
        logger.error("Reconcile failed: %s", e)
        self._meta.status = BookStatus.RECONCILE_FAILED
        self._meta.analysis_progress.reconcile_done = False
        # 降级：仍可出图， reconcile_done=false
```

### 8.2 SSE 进度

新增 reconcile 阶段的 SSE 事件：

```
event: progress
data: {"phase": "reconcile_running"}

event: done
data: {"phase": "analyzed", "reconcile_done": true, "chapters_done": 5}

event: done
data: {"phase": "reconcile_failed", "reconcile_done": false, "degraded": true, "chapters_done": 5}
```

### 8.3 失败/中断时的行为

| 场景 | 行为 |
|------|------|
| ReconcileAgent 超时/异常 | status=RECONCILE_FAILED, reconcile_done=false, 主流程不堵死 |
| PatchApplier 异常 | 同上（patch 部分应用则保持 RECONCILE_FAILED） |
| Orchestrator 被 stop | 如果在 reconcile 阶段被 stop → RECONCILE_FAILED（与现有 stop 逻辑一致） |
| suspects 为空 | 跳过 reconcile, 直接 ANALYZED + reconcile_done=true |

---

## 9. 配置

```python
# config.py 新增

max_reconcile_steps: int = Field(15, alias="MAX_RECONCILE_STEPS")
force_reconcile: bool = Field(False, alias="FORCE_RECONCILE")
```

- `max_reconcile_steps`：默认 15（低于章分析的 20，任务更聚焦）
- `force_reconcile`：可疑清单为空时是否仍跑一轮（默认 false）
- Reconcile 模型复用现有 `cfg.reconcile_model`（已定义在 config + llm.py）

---

## 10. 存储布局变化

```
workspace/{book_id}/
├── meta.json
├── cast.json
├── ledger/
│   └── chapter_*.json
├── overrides/
│   ├── cast_overrides.json        ← 现有（暂不使用）
│   └── relation_overrides.json    ← Reconcile 写入 + 人工写入
├── merge_queue.json               ← CastWriter 写入（保留）
├── todo_list.json                 ← 新增：Reconcile 待办
└── reconcile_report.json          ← 新增：校对结果摘要（审计用）
```

`reconcile_report.json` 示例：
```json
{
  "timestamp": "2026-07-15T...",
  "suspects_count": {"cast": 3, "relation": 2, "evidence": 1},
  "patch": { /* ReconcilePatch 原文 */ },
  "apply_result": {"merges_applied": 2, "aliases_applied": 1, ...}
}
```

---

## 11. 验收对照

| 需求 §8 验收项 | 实现点 |
|----------------|--------|
| 1. 章分析+合并后能进入总校对（或无可疑时正确跳过） | Orchestrator + SuspectsGenerator + is_empty 跳过 |
| 2. 别名重叠类可疑项，能建议合并或进待办 | CastConflict → Agent → MergeSuggestion / TodoItem |
| 3. 同一对人关系冲突，能裁决或进待办，可回查原文 | RelationConflict → Agent → 工具回查 → RelationChange / TodoItem |
| 4. 修改经过程序校验后落盘；非法 type/id 被拒绝 | submit_reconciliation 校验 + PatchApplier 校验 |
| 5. 总校对失败时主流程仍可标为可出图完成 | RECONCILE_FAILED 状态 + Aggregator 不依赖 reconcile |

---

## 12. 不做（非目标）

- 通读全书重抽关系
- 无依据大面积改图
- 一次塞进全部章正文
- `propose_cast_update`（Reconcile 不提议新人）
- 多层子 Agent 调度
- 前端 UI 改动（P0 先跑通后端）

---

## 13. 文件清单

### 新建

| 文件 | 职责 |
|------|------|
| `agent/reconcile_agent.py` | Reconcile Agent 运行时（tool-calling loop） |
| `agent/prompts/reconcile.py` | system/user prompt 构建 |
| `core/suspects.py` | SuspectsGenerator + detect_*_conflicts 函数 |
| `core/patch_applier.py` | PatchApplier |
| `models/reconcile.py` | ReconcilePatch / SuspectList 等数据模型 |

### 修改

| 文件 | 修改内容 |
|------|----------|
| `agent/tools.py` | +ReconcileToolContext +make_reconcile_tools |
| `agent/cast_writer.py` | _detect_conflicts → 调用 suspects.py 的 detect_cast_conflicts |
| `core/orchestrator.py` | _run() 尾部插入 suspects→reconcile→patch 流程 |
| `models/book.py` | BookStatus +RECONCILING +RECONCILE_FAILED |
| `config.py` | +max_reconcile_steps +force_reconcile |
| `storage/filestore.py` | +read/write relation_overrides + write todo_list |