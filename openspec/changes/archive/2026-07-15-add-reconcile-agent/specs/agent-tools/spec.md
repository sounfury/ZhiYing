## ADDED Requirements

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
- **WHEN** Agent 调用 `get_chapter_result(chapter_id=3)`，章 3 有 ledge
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