## ADDED Requirements

### Requirement: POST /analyze 端点
系统 SHALL 提供 `POST /api/books/{book_id}/analyze` 端点，启动分析流程。支持可选 query 参数 `to_chapter`（int）。若 book 不存在返回 404。若 `status==analyzing` 返回 409。成功返回 202 Accepted `{"status": "analyzing", "mode": "few_long", "total_chapters": N}`。分析在后台异步执行，不阻塞响应。

#### Scenario: 正常启动分析
- **WHEN** POST /api/books/{book_id}/analyze，book 存在且 status=uploaded
- **THEN** 返回 202，body 含 `{"status": "analyzing", "mode": "few_long", "total_chapters": 5}`，后台开始分析

#### Scenario: 带 to_chapter
- **WHEN** POST /api/books/{book_id}/analyze?to_chapter=10
- **THEN** 只分析 order ≤ 10 的 include_in_analysis=true 的章

#### Scenario: 书不存在
- **WHEN** POST /api/books/{不存在的id}/analyze
- **THEN** 返回 404，code=BOOK_NOT_FOUND

#### Scenario: 分析中重复请求
- **WHEN** POST /api/books/{book_id}/analyze，但 status=analyzing
- **THEN** 返回 409，code=ANALYSIS_ALREADY_RUNNING

### Requirement: GET /progress SSE 端点
系统 SHALL 提供 `GET /api/books/{book_id}/progress` 端点，返回 SSE 流。每章 Agent 完成时推送 `event: progress` data=`{chapter_id, done, total, status}`。全部完成时推送 `event: done` data=`{chapters_done, chapters_failed}`。单章失败时推送 `event: progress` data=`{chapter_id, status: "failed", error: "..."}`。连接关闭后流结束。

#### Scenario: 逐章进度推送
- **WHEN** 客户端连接 GET /progress，3 章分析中
- **THEN** 每章完成时收到 `event: progress` `data: {"chapter_id": 1, "done": 1, "total": 3, "status": "done"}`；最后一章后收到 `event: done` `data: {"chapters_done": 3, "chapters_failed": 0}`

#### Scenario: 单章失败推送
- **WHEN** ch2 的 Agent 失败
- **THEN** 收到 `event: progress` `data: {"chapter_id": 2, "done": 2, "total": 3, "status": "failed", "error": "LLM timeout"}`

### Requirement: POST /analyze/stop 端点
系统 SHALL 提供 `POST /api/books/{book_id}/analyze/stop` 端点，设置 stop flag 中断分析。返回 200 `{"status": "stopping"}`。运行中的 Agent 自然完成，未启动的章跳过。

#### Scenario: 停止分析
- **WHEN** POST /api/books/{book_id}/analyze/stop，分析正在进行
- **THEN** 返回 200 `{"status": "stopping"}`，Orchestrator 的 stop flag 被 set

### Requirement: GET /cast 端点
系统 SHALL 提供 `GET /api/books/{book_id}/cast` 端点，返回 cast.json 内容。若 cast.json 不存在返回空 cast `{"version": 0, "persons": []}`。

#### Scenario: 有 cast
- **WHEN** GET /api/books/{book_id}/cast，分析已完成，cast.json 有 5 人
- **THEN** 返回 `{"version": 3, "persons": [{...}, ...]}`

#### Scenario: 空 cast
- **WHEN** GET /api/books/{book_id}/cast，尚未分析
- **THEN** 返回 `{"version": 0, "persons": []}`

### Requirement: GET /chapters/{cid}/result 端点
系统 SHALL 提供 `GET /api/books/{book_id}/chapters/{chapter_id}/result` 端点，返回指定章的 ChapterLedger。若该章尚未分析（ledger 文件不存在）返回 404。

#### Scenario: 已分析的章
- **WHEN** GET /api/books/{book_id}/chapters/3/result，ch3 已分析完成
- **THEN** 返回 ChapterLedger JSON（含 persons、relations、events、summary）

#### Scenario: 未分析的章
- **WHEN** GET /api/books/{book_id}/chapters/5/result，ch5 未分析（无 ledger 文件）
- **THEN** 返回 404，code=BOOK_NOT_FOUND
