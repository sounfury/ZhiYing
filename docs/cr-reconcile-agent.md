# Code Review：全书总校对（Reconcile）链路

> 日期：2026-07-15  
> 范围：`add-reconcile-agent` 实现（Suspects / Reconcile Agent / PatchApplier / Orchestrator 集成）  
> 测试：`backend/tests/` 30 passed  
> 状态：骨架与主路径合格，可联调；上线前建议处理文中 P0

---

## 1. 总体评价

与 `docs/reconcile-agent-requirements.md` 及 `openspec/changes/add-reconcile-agent/design.md` 对齐良好：

```text
各章并行 → CastWriter 合并人名册
  → SuspectsGenerator 生成可疑清单
  →（空清单可跳过 / force_reconcile 可强制）
  → Reconcile Agent tool-calling loop
  → PatchApplier 应用 patch
  → ANALYZED | RECONCILE_FAILED
```

**做得好的地方：**

- 管线位置正确：barrier 之后、出图之前
- 空清单 + `force_reconcile` 跳过逻辑清晰
- `submit_reconciliation` 对非法 person_id / type / action 校验到位，工具不直写文件
- CastWriter 冲突检测抽出 `detect_cast_conflicts`，单一实现
- merge 后 ledger 自环丢弃、人/关系/事件 id 替换、别名并入 keep 主路径正确
- 降级：`RECONCILE_FAILED` + `degraded` + `reconcile_done=false`，不堵出图路径
- 配置齐全：`max_reconcile_steps` / `force_reconcile` / `LLM_RECONCILE_MODEL`
- Prompt 纪律与工具列表和需求一致
- 单测对 suspects / submit 校验 / patch 主路径覆盖不错

---

## 2. 发现项

### 2.1 [P0] 合并 id 映射不闭包，链式/交叉合并可能写坏库

**位置：** `backend/app/core/patch_applier.py` → `_apply_merges`  
**现象：** `id_remap` 只做一层映射；循环中不更新 `person_map`；`submit_reconciliation` 不校验 merge 之间的冲突。

| patch.merges 示例 | 实际风险 |
|-------------------|----------|
| `B→A` 再 `C→B` | ledger 里 `C` 变成 `B`，但 `B` 已从 cast 删除 → **幽灵 id** |
| `A→B` 与 `B→A` 同时提交 | 互相 remap，cast 可能两人都被删，行为未定义 |
| 同一 `drop_id` 出现两次 | dict 后者覆盖前者，**静默**丢掉一条 |

**说明：** 单条「两人并一人」主路径没问题；危险在一次 patch 内多条 merge 纠缠。

**建议：**

1. submit 校验：拒绝环、拒绝同一 drop 多次、拒绝 drop 再当 keep（或先拓扑解析）
2. apply 时对每个 drop 解析到最终 keep（闭包），再一次性改 cast / ledger / overrides

**符号约定：** `B→A` = `keep_id=A, drop_id=B`（保留 A，删 B，全库 B 换成 A）。

---

### 2.2 [P0] `RECONCILING` 未纳入防重入

**位置：** `backend/app/core/orchestrator.py` → `start()`

```python
if self._meta.status == BookStatus.ANALYZING:
    raise analysis_already_running(self.book_id)
```

章分析结束后 status 会切到 `RECONCILING`。此时再 `POST /analyze` 可通过检查，启动第二个 Orchestrator，与仍在跑的 reconcile 抢写 cast / ledger / meta。

**建议：**

```python
if self._meta.status in (BookStatus.ANALYZING, BookStatus.RECONCILING):
    raise analysis_already_running(...)
```

（可选：`get_orchestrator` 仍存活时再拦一层。）

---

### 2.3 [P1] `merges_applied` 等计数偏乐观

**位置：** `PatchApplier.apply`

跳过的 merge（id 找不到）仍计入 `merges_applied = len(patch.merges)`；aliases / relation_changes 同理。报告与日志会虚高。

**建议：** 计「实际生效条数」。

---

### 2.4 [P1] `submit_reconciliation` 成功判定脆弱

**位置：** `backend/app/agent/reconcile_agent.py`

- 用 `json.loads(tool_result)` 且无 try，异常形态非 JSON 可能炸掉 loop
- 更稳：以 `ctx.submit_patch is not None` 为准（与工具写 patch 绑定）

校验失败时 Agent 可重试，这点是对的。

---

### 2.5 [P1] 关系 `remove`/`add` 只写 overrides，当前「可出图」几乎无感

**位置：** `PatchApplier._apply_relation_changes` → `overrides/relation_overrides.json`

**按 design 是对的：** Aggregator 汇总时 `ledger → apply overrides → 出图`。  
**按现状：** Aggregator 尚未落地时，Agent 裁决的删边/加边**不会改 ledger**，若出图只读 ledger，则**看不见**关系修正。

对比：

| 操作 | 是否立刻改 ledger/cast | 当前观感 |
|------|------------------------|----------|
| 合并人 | 是 | 明显有效 |
| 加/删关系 | 否，只写 overrides | 像「写了文件但没干活」 |

**可选方向：**

1. 短期：remove/add 直接改 ledger（或 ledger + overrides 双写），立刻可见  
2. 保持 design：文档/前端写清「关系修正要等 Aggregator」；优先把 Aggregator 做出来  

**人话：** 合并人是直接改账本；改关系现在只写「事后便利贴」。便利贴要 Aggregator 叠到图上才生效。

---

### 2.6 [P2 / 已澄清] `同门` → `同学` 枚举改名

**位置：** `backend/app/domain/relation_types.py`

CR 初版标为「静默破坏性变更」。**产品侧已确认：主动改名，同学更合适。**

仍建议：

- 文档（如 `ARCHITECTURE.md` 示例）从 `同门` 对齐到 `同学`
- 若有旧 ledger，重跑分析或做读时兼容别名

---

### 2.7 [P2] 其它实现债

| 项 | 说明 | 状态 |
|----|------|------|
| `hard_soft_clash` | 未实现能力；注释已删，不做 | **已删注释** |
| `seen_pairs` | 死变量 | **已删** |
| 双冲突噪音 | 同一对人同时 overlap+cross 合并为一条 | **已修** |
| `reconcile_report.suspects_count` | 改名为 `patch_counts` | **已修** |
| 空 keyword 搜索 | 空串/空白拒绝 | **已修** |
| alias-only 不 bump version | 实际加别名时 bump | **已修** |
| overrides 合并后自环 | merge rewrite 时丢弃 | **已修** |
| 集成测试偏剧本 | 较少真正跑通 `Orchestrator._run` + Agent loop | 未做 |
| early `_push_done` | 补 `phase: failed` | **已修** |

---

## 3. 设计澄清（CR 讨论纪要，非 bug）

以下为评审过程中对齐的理解，便于后人读代码。

### 3.1 Ledger 里有什么

章产物 **`ledger/chapter_*.json` 同时含：**

- `persons`：本章人物 + 章内别名  
- `relations`：本章关系（type、方向、证据等）  
- `events` / `summary`：可选事件与章摘要  

全书通讯录在 **`cast.json`**，不在 ledger。

### 3.2 谁写账本、谁写补丁

| 阶段 | 谁 | 写什么 |
|------|-----|--------|
| 章分析 | Chapter Agent → `submit_result` | **本 ledger**（人+关系） |
| barrier | CastWriter（程序） | **cast** + ledger 内 person_id rewrite |
| 总校对 | Reconcile → PatchApplier | merges/aliases：**改 cast+ledger**；relation_changes：**overrides**；todos：todo 文件 |
| 出图 | Aggregator（未实现） | **读** ledger + **叠** overrides → GraphData |

关系补丁 **不是** 章 Agent 打的，是 **总校对提议、程序写 overrides**；出图时由 Aggregator 叠上，不是再跑一遍 Agent。

### 3.3 为啥不让总校对直接吐「全书关系图」

有意选择，不是实现偷懒：

1. **任务边界**：总校对只处理可疑点，不重做全书分析  
2. **事实源**：章 ledger 带章号+quote，可追溯；终稿大图易漂移  
3. **与人工改图同路径**：overrides 共用  
4. **确定性汇总**：过滤路人、前 N 章、soft/hard 压制适合程序（Aggregator）  
5. **降级**：总校对失败仍可用各章 ledger 出图  

### 3.4 Aggregator 是什么

**汇总出图模块（程序，非 AI）**：读 1..N 章 ledger → apply overrides → 过滤/打分/压制 → 输出 `nodes[] + edges[]`。  
当前 **未落地**；因此关系类 overrides 在产品上几乎不可见。

### 3.5 无向 / 有向（「双向关系」）

| | 含义 | 存储 |
|--|------|------|
| 无向 `directed=False` | 对称（夫妻、朋友…） | 只存一条，`person_a < person_b` 字典序 |
| 有向 `directed=True` | 有角色方向（亲子、师徒…） | `person_a=from, person_b=to` |

无向 **不是** 存两条反向边。有向同 type 正反同时出现 → `direction_clash` 进可疑清单。

### 3.6 关系枚举偏少与「粗类 + 展示文案」

- 短枚举是架构故意为之（可控校验、多标签、不做 GEN 厚映射）  
- 书中细称（舅公、情人、设定专有称呼）无法也不应全部进 SSOT  
- **产品倾向（讨论结论，未实现）：**  
  - **type**：系统粗类（枚举，管 soft/hard、冲突、筛选）  
  - **label / 展示文案**：可选，如「舅公」「道侣」，方便点边时看懂  
  - 可先有节制扩枚举（如恋人），细称走 label  

> 本文档只记录该产品意见，**不包含** label 字段的实现 diff。

### 3.7 `同学` 改名

产品确认主动从 `同门` 改为 `同学`，CR 不再当作误改。

---

## 4. 建议优先级汇总

| 优先级 | 项 |
|--------|-----|
| **P0** | 防重入包含 `RECONCILING` |
| **P0** | merge remap 闭包 + submit 拒绝环/冲突 drop |
| **P1** | 计数改「实际应用」；submit 成功看 `ctx.submit_patch` |
| **P1** | 关系 overrides 与出图路径对齐（做 Aggregator 或短期改 ledger）并写清文档 |
| **P2** | report 字段、空 keyword、dead code、硬集成测试、文档 `同门`→`同学` |
| **产品后续** | 粗类 type + 展示 label；按需扩枚举（如恋人） |

---

## 5. 主要涉及文件

| 路径 | 角色 |
|------|------|
| `backend/app/core/suspects.py` | 可疑清单 |
| `backend/app/agent/reconcile_agent.py` | 总校对 loop |
| `backend/app/agent/tools.py` | Reconcile 工具 + submit 校验 |
| `backend/app/agent/prompts/reconcile.py` | 总校对 prompt |
| `backend/app/core/patch_applier.py` | 应用 patch |
| `backend/app/core/orchestrator.py` | 管线集成 / 状态 / SSE |
| `backend/app/models/reconcile.py` | SuspectList / ReconcilePatch |
| `backend/app/models/book.py` | `RECONCILING` / `RECONCILE_FAILED` / `reconcile_done` |
| `backend/app/domain/relation_types.py` | 关系 SSOT |
| `backend/tests/test_*.py` | 单测与集成剧本 |

---

## 6. 结论

**可进联调。** 主路径（跳过 / 成功 / 失败降级）和单测基础扎实。  
上线或默认跑真书分析前，**务必处理 P0（防重入 + 链式 merge）**；关系修正可见性依赖 Aggregator 或明确降级说明，避免误判「校对没干活」。

---

*本文档由会话 CR 整理，含后续讨论澄清；实现以仓库代码为准。*
