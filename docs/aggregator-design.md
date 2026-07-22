# Aggregator 设计文档（汇总出图）

> 状态：设计草案（待评审）  
> 日期：2026-07-15  
> 依据：`docs/ARCHITECTURE.md` §4.4 / §5.2、`docs/PRD.md` §5.5、已实现的 ledger / cast / overrides / Reconcile  
> 范围：**确定性程序**，无 LLM；读账本 → 叠补丁 → 过滤打分 → 输出 `GraphData`

---

## 1. 目标与非目标

### 1.1 目标

1. 把「按章拆开的事实」汇总成前端可渲染的 **一张图**（`nodes` + `edges`）。  
2. 支持 **前 N 章防剧透**（`to_chapter`）与 **路人过滤**（`min_appearance`）。  
3. **叠上** 总校对 / 人工写入的 `relation_overrides`，使关系修正真正「可出图可见」。  
4. 落实 **多标签 + soft 被 hard 压制** 的展示规则（账本不删，展示可折）。  
5. 分析状态为 `analyzed` **或** `reconcile_failed` 时均可出图（降级可用）。

### 1.2 非目标（本层不做）

| 不做 | 说明 |
|------|------|
| 再跑 AI / 改关系语义 | 只读已有数据；裁决已在章 Agent / Reconcile / 人工 API |
| 写回 ledger | Aggregator **只读**；override 的落地由 PatchApplier / 人工 API 负责 |
| 布局算法 | 力导向等在前端 G6；后端只给拓扑与标签数据 |
| 完整聚焦子图 | P0：前端一度邻居过滤；后端可预留 `focus_person` 但不阻塞 MVP |
| 前缀增量结构 / 重 LRU | MVP 全量扫 1..N；缓存与 prefix 为预留 |

### 1.3 一句话

> **章账本 + 人名册 + 关系便利贴 → 确定性汇总 → GraphData。**  
> Aggregator 是会计出报表，不是编辑。

---

## 2. 在系统中的位置

```text
EPUB → 章分析 → CastWriter →（可选）Reconcile
                                      │
                    cast.json         │
                    ledger/*.json     │
                    overrides/relation_overrides.json
                                      ▼
                            ┌─────────────────┐
  GET /graph?to_chapter=N ─▶│   Aggregator    │
                            │   .compile()    │
                            └────────┬────────┘
                                     ▼
                              GraphData JSON
                                     ▼
                               前端 G6 渲染
```

| 上游 | Aggregator 用法 |
|------|-----------------|
| `cast.json` | 节点名、别名、性别、重要度、bio |
| `ledger/chapter_*.json` | 章内人物出现、关系边与证据 |
| `relation_overrides.json` | 对汇总边的 add / remove 补丁 |
| `meta.json` | `total_chapters`、状态（是否允许出图） |

**不依赖** `todo_list.json` / `reconcile_report.json`（人工待办，不进图）。

---

## 3. 输入 / 输出

### 3.1 API（P0）

```http
GET /api/books/{book_id}/graph
  ?to_chapter=80          # 可选；默认 = 已分析章上界或 total_chapters（见 §3.2）
  &min_appearance=2       # 可选；默认 2
  &type_filter=夫妻,师徒  # 可选；逗号分隔，只保留这些 type 的 tag
  &include_suppressed=0   # 可选；0/1，默认 0（不返回 suppressed=true 的 tag）
```

**允许出图的 status（建议）：**

- `analyzed`
- `reconcile_failed`（章结果完整，仅未校对或校对失败）
- 可选：`analyzing` / `reconciling` 时返回 **已完成章** 的部分图（P0 可不做，先 409）

**拒绝：**

- book 不存在 → 404  
- 尚无任何 ledger / 状态 `uploaded` → 409 或空图（二选一，建议：**空 `nodes/edges` + chapter_range**，便于前端占位）

### 3.2 `to_chapter` 语义

| 情况 | 行为 |
|------|------|
| 未传 | 取 `min(meta.total_chapters, max(analysis_progress.chapters_done ∪ 有 ledger 的章))`；无则 0 → 空图 |
| 传入 N | 只使用 `chapter_id <= N` 且文件存在的 ledger |
| N 大于已有 | 静默截到实际最大已存在章 |

`chapter_range` 响应字段：`[1, effective_N]`（若无章则 `[]` 或 `[1,0]`——建议 **`[1, effective_N]` 且 effective_N≥1 才有**；无数据时 `chapter_range: []`）。

### 3.3 输出：`GraphData`（已有模型）

与 `backend/app/models/graph.py` 对齐，不另起炉灶：

```text
GraphData
  book_id, chapter_range, total_chapters
  nodes: GraphNode[]
  edges: GraphEdge[]          # 一对人一条 edge，多关系在 tags[]
  filtered_count
  filtered_persons[]          # 被路人过滤掉的人（便于 UI「显示被隐藏的」）
```

| 字段 | 来源 |
|------|------|
| Node.name / aliases / gender / importance / bio | cast |
| Node.appearance_count | 前 N 章 ledger.persons 中出现的 **不同章数** |
| Edge.person_a / person_b | 见 §4.3 端点规范化 |
| Tag.type / tier / directed | relation SSOT + 账本 |
| Tag.chapter_ids | 合并后的有序章号列表 |
| Tag.evidences | `{chapter_id, quote}` 列表（可截断，见 §6） |
| Tag.display_score | §4.5 公式 |
| Tag.suppressed | §4.6 |

**本版不引入 `label` 展示文案字段**（粗类 + 文案的产品方向可后续加；P0 边上只显示枚举 `type`）。

---

## 4. 核心算法

### 4.1 总流程

```text
compile(book_id, to_chapter, min_appearance, type_filter, include_suppressed):

  1. 读 meta、cast；列 1..N 的 ledger（跳过缺失文件）
  2. 从 ledgers 收集：
       - appearance: person_id → set(chapter_id)
       - raw_edges: 每条章关系 → 规范化后的 (pair_key, type, directed, evidence…)
  3. apply_overrides(raw_edges)     # §4.2
  4. aggregate_by_key(raw_edges)    # §4.3 合并 chapter_ids / evidences
  5. score_and_suppress(tags)       # §4.5–4.6
  6. filter_types(type_filter)
  7. filter_suppressed(include_suppressed)
  8. build_nodes + filter_persons   # §4.7
  9. 挂边：仅保留两端都在「可见节点」集合中的 edge
 10. return GraphData
```

### 4.2 Apply overrides

文件：`workspace/{book_id}/overrides/relation_overrides.json`

```json
{
  "add": [
    {
      "person_a": "p001",
      "person_b": "p002",
      "type": "夫妻",
      "chapter_id": 3,
      "quote": "...",
      "note": "..."
    }
  ],
  "remove": [
    {
      "person_a": "p001",
      "person_b": "p002",
      "type": "朋友",
      "chapter_id": 1
    }
  ]
}
```

**规则（P0）：**

1. 先把全部 ledger 关系展平为「条目列表」（每章每条 relation 一条）。  
2. **remove**：匹配键  
   - 无向：`(norm_a, norm_b, type)` 且可选 `chapter_id`  
   - 有向：`(from, to, type)` 且可选 `chapter_id`  
   - **P0 约定：**  
     - 若 remove 带 `chapter_id`：只删该章该 type 的条目  
     - 若不带或 `chapter_id=0`：删该 pair+type 在 1..N 内 **全部章** 的条目  
3. **add**：追加条目（视为该 `chapter_id` 下的一条关系）；`type` 非法则 **跳过并打日志**（不 500）。  
4. add/remove 中的 person_id 以 cast 为准；未知 id **跳过**。  
5. 自环（apply 后 a==b）**丢弃**。

> 与 Reconcile PatchApplier 写入格式保持一致；人工 `PUT /relations`（后续）写同一文件。

**顺序：** `ledger 展开 → remove → add`（add 可恢复被误 remove 的边，便于人工纠错）。

### 4.3 边键与聚合

| 边类型 | 聚合键 | edge 端点展示 |
|--------|--------|----------------|
| 无向 | `(min(a,b), max(a,b), type)` | `person_a < person_b` 字典序 |
| 有向 | `(from, to, type)` | `person_a=from, person_b=to` |

**同一对人物、多种 type → 同一 `GraphEdge` 下多个 `GraphTag`。**

```text
# 伪结构
edge_map[(a,b)] -> {
  tags: {
    type -> { chapter_ids: set, evidences: list, directed, tier }
  }
}
```

- `chapter_ids`：有序去重  
- `evidences`：按章追加；无 quote 的也可保留（仅 chapter_id）；**上限**见 §6  
- `tier` / `directed`：一律以 `relation_types` SSOT 为准，不信落盘脏字段  

**非法 type（旧数据如历史「同门」）：** 跳过该条 + warning 日志，不拖垮整图。

### 4.4 出现次数 `appearance_count`

```text
person 在 chapter C 出现 ⇔ ledger[C].persons 中含该 person_id
appearance_count = |{ C | C ≤ N 且出现 }|
```

- **不以**「仅出现在 relation 端点」计（避免只被别人提到的幽灵计入）。  
- cast 有、但 1..N 从未进任何 ledger.persons → count=0，默认进 filtered（除非后面 hard 规则）。

### 4.5 `display_score`

与架构一致：

```text
score = tier_base(type) + 0.5 * len(chapter_ids) + (1 if 任一条 evidence.quote 非空 else 0)

tier_base: hard=5, mid=3, soft=1   # domain/relation_types.tier_base_score
```

用于前端排序 / 默认展示优先级；**不**用于硬删除。

### 4.6 Soft 压制（suppressed）

对 **同一对人物**（无向看无序对；有向也按「无序对」判断是否存在 hard？）

**P0 约定（与 PRD 一致、实现简单）：**

- 取无序 pair `(min_id, max_id)`  
- 若该 pair 上 **任意方向、任意 hard type** 的 tag 存在  
- 则该 pair 上所有 **soft** tier 的 tag 标记 `suppressed=true`  
- **mid 不压制、也不被 soft 压制**；hard 之间不互压  

`include_suppressed=0`（默认）：响应中 **不包含** `suppressed=true` 的 tag；若某 edge 的 tags 被删空，则 **去掉整条 edge**。  
`include_suppressed=1`：带上 suppressed 标记，前端可折进「更多」。

### 4.7 路人过滤

```text
visible person 若满足：
  appearance_count >= min_appearance
  OR 在「可见边」上存在至少一条 hard tag（压制前）
  OR importance == main（可选增强，P0 建议做：主线人物不因出镜少被藏）
```

**P0 推荐规则（写死可配默认）：**

1. `appearance_count >= min_appearance` → 可见  
2. 否则若参与至少一条 **hard** 关系（在 type 过滤之前、对 1..N 全量 tag 判断）→ 可见  
3. 否则若 `cast.importance == main` → 可见  
4. 否则 → `filtered_persons`，不进 `nodes`

然后：

- 边的两端都必须 visible，否则丢边  
- `filtered_count = len(filtered_persons)`

### 4.8 `type_filter`

- 解析为 type 集合；非法名忽略  
- 只保留 tag.type ∈ 集合的 tag  
- 过滤后 tags 为空则去 edge  
- **不影响** appearance 与路人 hard 判定所用的「全量 hard」（避免筛「只看朋友」时把因 hard 留下的人误杀——P0 简化：**type_filter 仅作用于输出 tags**，路人规则仍看未 filter 前的 hard）

---

## 5. 模块与代码落点

### 5.1 建议文件

```text
backend/app/core/aggregator.py      # Aggregator.compile() 主逻辑
backend/app/models/graph.py         # 已有，必要时小改
backend/app/api/analysis.py         # 或 books.py：挂 GET /graph
backend/tests/test_aggregator.py    # 单测
```

### 5.2 类接口（示意）

```python
@dataclass
class GraphQuery:
    to_chapter: int | None = None
    min_appearance: int = 2
    type_filter: list[str] | None = None
    include_suppressed: bool = False


class Aggregator:
    def __init__(self, book_id: str, filestore: Filestore) -> None: ...

    def compile(self, query: GraphQuery) -> GraphData:
        """纯同步、可线程池包装；无 IO 写。"""
        ...
```

API 层：

```python
@router.get("/{book_id}/graph")
async def get_graph(book_id: str, to_chapter: int | None = None, ...):
    data = await asyncio.to_thread(Aggregator(book_id, fs).compile, query)
    return data.model_dump()
```

### 5.3 与现有组件边界

| 组件 | 边界 |
|------|------|
| Orchestrator | 不调用 Aggregator；分析结束不预计算整图（按需 GET） |
| PatchApplier | 只写 overrides/cast/ledger；不负责出图 |
| CastWriter | 不参与 |
| Reconcile | 间接：写 overrides / merge 后 ledger 被 Aggregator 读到 |

---

## 6. 性能与缓存（分层）

### 6.1 MVP（必须）

- 单书章数 ≤ 数百、每章 JSON 小：每次 `compile` **全量读 1..N ledger** 可接受  
- `asyncio.to_thread` 避免堵 event loop  
- 证据列表：**每个 tag 最多保留 K 条**（建议 K=5，优先有 quote 的）

### 6.2 预留（不做实现也可在接口留 hook）

| 手段 | key / 策略 |
|------|------------|
| 进程内 LRU | `(book_id, to_chapter, min_appearance, type_filter_fp, include_suppressed, cast.version, overrides_mtime)` |
| 失效 | `write_cast` / `write_ledger` / `write_relation_overrides` 时 `invalidate(book_id)` |
| 前缀聚合 | 滑块拖动时 O(Δ)，二期 |

P0 **可不做缓存**，文档保留约定以免以后改 API。

---

## 7. 错误与降级

| 情况 | 行为 |
|------|------|
| 无 ledger | 空图，200 |
| 部分章缺失 | 跳过，不报错 |
| overrides 文件损坏 | 当 `{"add":[],"remove":[]}` + error 日志 |
| cast 缺人但 ledger 有 id | 节点用 `person_id` 作 name 兜底，aliases=[] |
| RECONCILE_FAILED | 正常出图（ledger+cast 仍完整；overrides 可能为空或部分） |
| ANALYZING | P0：409 `ANALYSIS_RUNNING` 或仅汇总已 done 章——**推荐 409 简单** |

---

## 8. 测试计划

| 用例 | 断言 |
|------|------|
| 两章同 pair 同 type | 一个 tag，`chapter_ids` 含两章，evidences 合并 |
| 同 pair 不同 type | 一条 edge，两个 tags |
| 有向不合并反边 | `A→B 亲子` 与 `B→A 亲子` 两条 tag/边键分离 |
| hard+soft 同 pair | soft.suppressed=true；默认响应无 soft tag |
| include_suppressed=1 | soft 仍在且 suppressed |
| min_appearance=2 | 仅 1 章路人进 filtered；有 hard 的 1 章人仍可见 |
| to_chapter 截断 | 只用 ≤N 的章；appearance 同步截断 |
| override remove 带 chapter | 只掉该章；聚合 chapter_ids 变短 |
| override remove 不带 chapter | 该 pair+type 全掉 |
| override add | 图上出现新 tag |
| 非法 type / 未知 person | 跳过，其余正常 |
| merge 后 id | 只出现 keep_id（依赖 ledger 已 rewrite，Aggregator 不再二次 merge 人） |

---

## 9. 实现任务拆分（建议 PR 序）

| # | 任务 | 产出 |
|---|------|------|
| 1 | `Aggregator` 纯函数核心：读 ledger + 聚合 + score/suppress + 过滤 | `core/aggregator.py` + 单测 |
| 2 | overrides apply | 单测覆盖 add/remove |
| 3 | `GET /graph` 接线 + 参数校验 | API 可调 |
| 4 | （可选）空状态 / analyzing 策略与错误码对齐 | 与前端约定 |
| 5 | （可选）LRU 缓存 + 写路径 invalidate | 性能 |

**预估：** 核心 + API + 单测约 1 个小迭代；不包含前端 G6。

---

## 10. 开放问题（请拍板）

1. **`analyzing` 时是否允许部分出图？**  
   - A）一律 409（实现简单）  
   - B）按 `chapters_done` 出部分图（体验好、边界多）

2. **`importance=main` 是否永远可见？**  
   - 本文默认 **是**；若否，严格只靠 appearance / hard。

3. **remove 不带 `chapter_id` 是否删全章？**  
   - 本文默认 **是**；若否，改为必须带章号。

4. **证据截断 K=5 是否够用？**  
   - 详情页若要「全部证据」，可另做 `GET .../edge-detail`（非 P0）。

5. **展示文案 `label`**  
   - 本设计 P0 不做；若上 label，聚合键仍只按 `type`，label 取「出现最多或最新有值的」。

---

## 11. 验收标准（最小）

1. 分析完成后 `GET /graph` 返回非空合理节点边（样例书）。  
2. `to_chapter` 变小后，后章人物/关系消失。  
3. `min_appearance` 调高，路人进 `filtered_persons`。  
4. Reconcile 写入的 **relation add/remove** 在图上可见（补齐当前「补丁无感」缺口）。  
5. 同 pair 的 soft 在 hard 存在时默认不展示（或标 suppressed）。  
6. `reconcile_failed` 仍可出图。  

---

## 12. 总结

| 项 | 决定 |
|----|------|
| 职责 | 只读汇总出图，确定性 |
| 事实源 | ledger + cast + relation_overrides |
| 多标签 | 一对人一条 edge，多 tag |
| 防剧透 | `to_chapter` |
| 路人 | appearance + hard 例外 +（建议）main |
| 压制 | pair 上有 hard → soft suppressed |
| 缓存 | P0 不做，预留 key 约定 |
| AI | 无 |

**Aggregator 做完后，总校对的关系补丁与人工 override 才进入用户可见的闭环。**

---

*评审通过后可按 §9 拆任务实现；若需 OpenSpec change，可从本文裁剪 proposal/tasks。*
