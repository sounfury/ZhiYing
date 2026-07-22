## ADDED Requirements

### Requirement: read_chapter_window tool
系统 SHALL 提供 `read_chapter_window` LangChain 工具，按字符偏移读取当前章正文的指定窗口。`limit` 参数上限强制为 `settings.read_window_chars`（默认 5000），超出截断。返回固定 JSON 格式：`{chapter_id, segment_index, offset, limit, total_chars, has_more, text}`。`segment_index` 从 0 递增。工具 SHALL 绑定到当前章（`book_id` + `chapter_id` 由上下文注入，模型不需传递）。

#### Scenario: 正常读取第一窗
- **WHEN** Agent 调用 `read_chapter_window(offset=0, limit=5000)`，当前章 char_count=12000
- **THEN** 返回 `{chapter_id=当前章, segment_index=0, offset=0, limit=5000, total_chars=12000, has_more=true, text="前5000字符..."}`

#### Scenario: limit 超过上限被截断
- **WHEN** Agent 调用 `read_chapter_window(offset=0, limit=10000)`，`read_window_chars` 配置为 5000
- **THEN** 实际只返回 5000 字符，返回的 `limit` 字段为 5000

#### Scenario: 读取最后一窗
- **WHEN** Agent 调用 `read_chapter_window(offset=10000, limit=5000)`，total_chars=12000
- **THEN** 返回 `text` 为 offset 10000 到 12000 的 2000 字符，`has_more=false`

### Requirement: grep_in_chapter tool
系统 SHALL 提供 `grep_in_chapter` LangChain 工具，在当前章正文中搜索关键词，返回匹配行及上下文。返回格式为命中行列表 `[{line_number, text}]`。工具 SHALL 绑定到当前章。

#### Scenario: 搜索到匹配
- **WHEN** Agent 调用 `grep_in_chapter(keyword="黛玉")`，章节正文包含"黛玉"3 次
- **THEN** 返回 3 条匹配行，每条含 line_number 和所在行全文

#### Scenario: 无匹配
- **WHEN** Agent 调用 `grep_in_chapter(keyword="不存在的名字")`
- **THEN** 返回空列表 `[]`

### Requirement: query_cast tool
系统 SHALL 提供 `query_cast` LangChain 工具，返回当前冻结的 cast 只读快照（JSON 格式）。快照在 Chapter Agent 启动时冻结，分析过程中不更新。快照可为空（无 cast）。

#### Scenario: 有 cast 数据
- **WHEN** Agent 调用 `query_cast()`，cast 快照有 3 个人物
- **THEN** 返回包含 3 个 Person 的 JSON（含 person_id、canonical_name、aliases）

#### Scenario: 空 cast
- **WHEN** Agent 调用 `query_cast()`，cast 为空（无 NLP Cast Pass）
- **THEN** 返回 `{"version": 0, "persons": []}`

### Requirement: propose_cast_update tool
系统 SHALL 提供 `propose_cast_update` LangChain 工具，接受 `canonical_name`、`aliases`、`bio`、`gender`、`importance` 参数，将人物存入 per-chapter `cast_buffer`，返回分配的临时 person_id。临时 id 格式为 `ch{cid}_p{n}`（如 `ch3_p1`）。同一章内同一 `canonical_name` 的重复 propose SHALL 返回已有 id 而非创建新的。

#### Scenario: 首次 propose 新人物
- **WHEN** Agent 调用 `propose_cast_update(canonical_name="薛宝钗", aliases=["宝钗"])`，当前 chapter_id=5
- **THEN** 返回 `{"person_id": "ch5_p1", "status": "proposed"}`，cast_buffer 中存入该人物

#### Scenario: 重复 propose 同名人物
- **WHEN** Agent 再次调用 `propose_cast_update(canonical_name="薛宝钗")`
- **THEN** 返回已有的 `ch5_p1`，不创建新条目

### Requirement: submit_result tool
系统 SHALL 提供 `submit_result` LangChain 工具，接受 `persons`（含 aliases_in_chapter）、`relations`、`events`、`summary` 参数，校验后存入 ChapterLedger。校验规则：(1) 每条 relation 的 `type` 必须在 `RELATION_TYPES` 枚举内；(2) `person_a`/`person_b` 必须在 cast 快照或当前章 cast_buffer 中存在；(3) 不允许自环。校验失败 SHALL 返回错误字符串（不抛异常），提示合法选项。成功返回 `{"status": "submitted"}`。

#### Scenario: 成功提交
- **WHEN** Agent 调用 `submit_result`，所有 relation 的 type 合法且 person_id 存在于 cast 快照或 buffer 中
- **THEN** 将 ChapterLedger 写入内存 buffer，返回 `{"status": "submitted"}`

#### Scenario: 非法 relation type
- **WHEN** Agent 提交的某条 relation type 为 "恋人"（不在枚举内）
- **THEN** 返回错误字符串 `"INVALID_RELATION_TYPE: '恋人'. Valid types: 夫妻, 亲子, 兄妹, ..."`，不写入 ledger

#### Scenario: person_id 不存在
- **WHEN** Agent 提交的 relation 引用 person_id "p999"，该 id 既不在 cast 快照也不在 cast_buffer
- **THEN** 返回错误字符串 `"INVALID_PERSON_ID: 'p999' not found. Use propose_cast_update first or query_cast to check existing ids."`，不写入 ledger

#### Scenario: 自环关系
- **WHEN** Agent 提交的 relation 中 person_a == person_b
- **THEN** 返回错误字符串 `"SELF_LOOP: person_a and person_b must be different"`

### Requirement: ReconcileToolContext 上下文
系统 SHALL 提供 `ReconcileToolContext` dataclass，包含 `book_id: str`、`cast: Cast`（合并后最终版只读）、`suspects: SuspectList`、`chapter_summaries: dict[int, str]`、`filestore: Filestore`、`submit_patch: ReconcilePatch | None`。Reconcile Agent 的工具通过闭包引用此上下文。

#### Scenario: 上下文初始化
- **WHEN** 创建 ReconcileToolContext，传入 cast 和 suspects
- **THEN** submit_patch 为 None，工具可通过 ctx.cast 和 ctx.suspects 读取数据

### Requirement: search_in_chapter tool
系统 SHALL 提供 `search_in_chapter` LangChain 工具，在**指定章**正文中搜索关键词，返回匹配行列表 `[{line_number, text}]`，上限 50 条。参数 `chapter_id: int` 指定搜索的章，`keyword: str` 为搜索词。

#### Scenario: 跨章搜索
- **WHEN** Agent 调用 `search_in_chapter(chapter_id=5, keyword="黛玉")`，章 5 正文包含"黛玉"3 次
- **THEN** 返回 3 条匹配行，每条含 line_number 和行文本

#### Scenario: 无匹配
- **WHEN** Agent 调用 `search_in_chapter(chapter_id=5, keyword="不存在的名字")`
- **THEN** 返回空列表 `[]`

#### Scenario: 章不存在
- **WHEN** Agent 调用 `search_in_chapter(chapter_id=999, keyword="黛玉")`，章 999 不存在
- **THEN** 返回 `{"error": "..."}` 错误字符串

### Requirement: read_chapter_text tool
系统 SHALL 提供 `read_chapter_text` LangChain 工具，读取**指定章**正文的字符窗口。参数 `chapter_id: int`、`offset: int`（>= 0）、`limit: int`（> 0，上限强制为 `settings.read_window_chars`）。返回固定格式：`{chapter_id, segment_index, offset, limit, total_chars, has_more, text}`。

#### Scenario: 读取指定章窗口
- **WHEN** Agent 调用 `read_chapter_text(chapter_id=3, offset=0, limit=5000)`
- **THEN** 返回章 3 从 offset 0 开始最多 5000 字符的正文窗口

#### Scenario: limit 被截断
- **WHEN** Agent 调用 `read_chapter_text(chapter_id=3, offset=0, limit=99999)`，read_window_chars=5000
- **THEN** 实际返回 5000 字符

### Requirement: get_chapter_result tool
系统 SHALL 提供 `get_chapter_result` LangChain 工具，返回指定章的 ChapterLedger（persons + relations + events + summary），格式为 JSON 字符串。只读，不修改数据。

#### Scenario: 查看章结果
- **WHEN** Agent 调用 `get_chapter_result(chapter_id=3)`，章 3 有 ledger
- **THEN** 返回 chapter_003.json 的完整 JSON 内容

#### Scenario: 章未分析
- **WHEN** Agent 调用 `get_chapter_result(chapter_id=999)`，该章无 ledger
- **THEN** 返回 `{"error": "Chapter result not found: 999"}`

### Requirement: query_cast (Reconcile 版)
系统 SHALL 在 Reconcile 工具集中提供 `query_cast` 工具，返回 ReconcileToolContext.cast（合并后最终版）的只读快照。功能与 ChapterAgent 版相同，但数据源为合并后的 cast 而非冻结快照。

#### Scenario: 查询最终人名册
- **WHEN** Agent 调用 `query_cast()`，cast 有 5 人
- **THEN** 返回 5 个 Person 的 JSON（含 person_id, canonical_name, aliases, bio, gender, importance）

### Requirement: submit_reconciliation tool
系统 SHALL 提供 `submit_reconciliation` LangChain 工具，接受 `merges`、`aliases`、`relation_changes`、`todos` 四个列表参数，校验后存入 `ctx.submit_patch`。校验规则：(1) merges 中 keep_id 和 drop_id 必须在 cast 中存在且不相等；(2) aliases 中 person_id 必须在 cast 中存在；(3) relation_changes 中 action 必须为 "add" 或 "remove"，person_a/person_b 必须在 cast 中存在，type 必须在 RELATION_TYPES 枚举内；(4) todos 中 description 不为空。校验失败 SHALL 返回错误字符串（不抛异常）。成功返回 `{"status": "submitted"}`。

#### Scenario: 成功提交 patch
- **WHEN** Agent 调用 submit_reconciliation，所有条目校验通过
- **THEN** 将 ReconcilePatch 存入 ctx.submit_patch，返回 `{"status": "submitted"}`

#### Scenario: merge 引用不存在的 id
- **WHEN** patch.merges 有 {keep_id="p001", drop_id="p999"}，p999 不在 cast 中
- **THEN** 返回错误字符串 `"INVALID_PERSON_ID: 'p999' not found in cast"`，不写入 patch

#### Scenario: relation type 非法
- **WHEN** patch.relation_changes 有 {action="add", type="恋人"}
- **THEN** 返回错误字符串提示合法类型列表，不写入 patch
