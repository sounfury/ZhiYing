## Context

CastAtlas 的基础设施层已就位（config、errors、relation_types SSOT、Pydantic models、Filestore、LLM Provider、EPUB Parser、books API）。本变更实现分析管线的 P0 闭环：Agent 工具 → Chapter Agent → Orchestrator（few_long）→ 分析 API。

已有基础：
- `Relation` model 的 `model_validator` 已在反序列化层做 type 枚举校验 + 端点规范化 + 自环拒绝
- `CastPropose` model 已定义（propose_cast_update 工具的出参）
- `Filestore` 全量读写就绪（chapters/cast/ledger/meta）
- `relation_types.py` 含 `relation_summary_for_prompt()` 生成器
- `config.py` 已含 `inject_max_chars`/`read_window_chars`/`read_overlap_chars`/`max_agent_steps`/`max_parallel_chapters`
- `BookStatus` 枚举已有 `ANALYZING`/`ANALYZED`；`AnalysisMode` 已有 `FEW_LONG`

架构依据：ARCHITECTURE.md v0.8 §4.3（Chapter Agent）、§4.3.1（正文注入与阅读窗）、§4.6.2（few_long 模式）、§4.6.3（Cast Writer）、§2.1（LangChain 作用域）。

## Goals / Non-Goals

**Goals:**
- 从空 cast 起步，跑通「上传 EPUB → 启动分析 → 查看 cast + 章账本」
- few_long 模式：全章并行（semaphore 控制）+ 确定性预合并 + 无 LLM Reconcile
- 临时 person_id per-chapter 隔离，CastWriter 顺序 apply 分配正式 id
- submit_result 校验失败返回错误字符串给模型，不静默吞掉
- SSE 逐章推送进度

**Non-Goals:**
- LLM Reconcile / Check-Merge Agent（P1）
- Aggregator / GET /graph（另一期 change）
- NLP Cast Pass、Memory Manager、many_chapters 波次模式（P1）
- 前端改动
- path jail / catalog / jobs 框架（P2）

## Decisions

### D1: 临时 person_id 格式 = `ch{cid}_p{n}`

每个 ChapterAgent 实例维护自己的 `cast_buffer: dict[str, CastPropose]`，key 为 `ch{cid}_p{n}`（如 `ch3_p1`、`ch3_p2`）。临时 id 自带章号，ledger 文件可读、调试直观。多 Agent 并行时天然不冲突（不同章号不同前缀）。

**备选（已否）：** 全局 UUID——通用但调试不直观；直接用 canonical_name 做 key——同名人物无法区分。

### D2: ledger 先存临时 id，CastWriter apply 后 rewrite

Agent 完成后立即将含临时 person_id 的 ledger 写入 `ledger/chapter_{cid}.json`（持久化中间态，崩溃不丢）。CastWriter 顺序 apply 完成后，用临时→正式 id 映射表 rewrite 这些文件。

**备选（已否）：** 内存暂存后落盘（崩溃丢失产物）；tmp 文件中转（额外 IO 但 MergeState 不可读）。

### D3: person_id 存在性闸门在工具层

`submit_result` 在构造 `Relation` 前手动检查：
1. `person_a` / `person_b` 是否在 cast 快照 ∪ 当前章 cast_buffer 中
2. `type` 是否在 `RELATION_TYPES` 枚举内（可借 `is_valid_type()`）
3. 不合法 → return error string（如 `"INVALID_PERSON_ID: 'p999' not in cast or buffer. Use propose_cast_update first."` 不抛异常

`Relation` 的 Pydantic `model_validator` 作为二级兜底：如果工具层校验通过但 model 仍有问题（如无向端点规范化），Validator 在 `Relation(**data)` 时抛 ValueError，工具层 try/except 后同样转错误字符串。

### D4: read_chapter_window 固定返回格式 + 强制 limit

```
返回: {chapter_id, segment_index, offset, limit, total_chars, has_more, text}
```

- `limit` 参数上限硬编码为 `settings.read_window_chars`（5000），超出截断
- `offset` 指字符偏移（非字节、非行号）
- `segment_index` 从 0 递增，便于模型判断读到第几窗
- `has_more` 告知是否还有后续正文

### D5: propose_cast_update 只缓冲，不直接写 cast.json

propose 返回分配的临时 id (`ch{cid}_p{n}`)，存入 per-chapter `cast_buffer`。CastWriter 在 barrier 后顺序 apply，分配正式 `p00N` id。`query_cast` 只返回冻结快照（开跑时 cast version），不返回其他章的 propose（few_long 无章间交互）。

### D6: P0 无 LLM Reconcile——只做程序基本合并

确定性预合并（程序逻辑，不调 LLM）：
- canonical_name 完全一致 → 合并别名到已有 person，ledger 中的临时 id 映射到同一正式 id
- 别名重叠但 canonical_name 不同 → 写入 `merge_queue.json` 待人工修正（不阻塞 status=analyzed）
- 同 pair + 同 type 的重复关系边 → Aggregator 合并证据（Aggregator 属另一期，此处只确保 ledger 文件去重格式正确）

### D7: SSE 逐章推送

few_long 无波次，SSE 以单章为粒度。Orchestrator 维护 `asyncio.Queue`，每章 Agent 完成后推 `event: progress`；全部完成后推 `event: done`。API 端点从 queue 读取并 SSE 推送。

### D8: to_chapter 简单截断

`POST /analyze?to_chapter=N`：若传了 N，只调度 `order ≤ N 且 include_in_analysis=true` 的章。不传 = 全部分析章。几行代码，不做 from_chapter。

### D9: 防重入 + 粗糙 stop flag

- 防重入：`meta.status == ANALYZING` → 返回 409 `ANALYSIS_ALREADY_RUNNING`
- Stop flag：Orchestrator 持 `asyncio.Event`，`POST /analyze/stop` set 它；Map 阶段每个 Agent 启动前检查 flag，已启动的等其自然完成（不强杀 LLM 请求）

### D10: LangChain 工具注册方式

使用 `langchain-core` 的 `@tool` 装饰器注册工具函数。工具需要的上下文（book_id、chapter_id、cast_snapshot、cast_buffer）通过闭包或类实例注入，不要求模型传递。

```python
class ChapterToolContext:
    book_id: str
    chapter_id: int
    cast_snapshot: Cast
    cast_buffer: dict[str, CastPropose]
    filestore: Filestore
    submit_buffer: ChapterLedger | None  # submit_result 写入此

def make_tools(ctx: ChapterToolContext) -> list[BaseTool]:
    @tool
    def read_chapter_window(offset: int, limit: int) -> str:
        ...
    return [read_chapter_window, ...]
```

## Risks / Trade-offs

- **[临时 id 在 ledger 中不可读]** → 选用 `ch{cid}_p{n}` 格式自带章号，rewrite 后正式 id 更可读；中间态仅在 CastWriter apply 前短暂存在
- **[长章 token 爆炸]** → `read_chapter_window` 强制 limit + `max_agent_steps` 按窗数抬高；短章整章注入控制在 `inject_max_chars` 以内
- **[submit_result 校验失败导致 Agent 循环不收敛]** → 错误字符串明确提示合法选项；`max_agent_steps` 兜底
- **[多 Agent propose 同人但 canonical_name 拼写不一致]** → P0 不做模糊匹配，只按完全一致合并；剩余进 merge_queue 供人工修正
- **[崩溃时 ledger 残留临时 id]** → rewrite 前 ledger 已持久化；重启后可检测 status==analyzing 但未 rewrite 的章，手动 rerun 或程序补做 rewrite
- **[LangChain 版本兼容]** → 版本锁定 `langchain-core` + `langchain-openai`，避免 community 全家桶
