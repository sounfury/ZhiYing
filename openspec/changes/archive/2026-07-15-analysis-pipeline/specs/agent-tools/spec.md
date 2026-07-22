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
