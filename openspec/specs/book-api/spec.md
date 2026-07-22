## ADDED Requirements

### Requirement: Upload EPUB
系统 SHALL 提供 POST /api/books/upload 端点，接收 EPUB 文件，解析后落盘到 workspace，返回 book_id。

#### Scenario: 成功上传
- **WHEN** 客户端 POST 一个有效的 .epub 文件到 /api/books/upload
- **THEN** 系统生成 book_id（uuid4），调用 EPUB Parser 解析，通过 Filestore 落盘 meta.json 和 chapters/*.json，返回 `{"book_id": "...", "title": "...", "total_chapters": N}`

#### Scenario: 非 EPUB 文件
- **WHEN** 客户端 POST 一个 .txt 文件
- **THEN** 返回 422 错误，code = VALIDATION_ERROR，message 说明只接受 .epub

#### Scenario: EPUB 解析失败
- **WHEN** 客户端 POST 一个损坏的 .epub 文件（无法被 ebooklib 读取）
- **THEN** 返回 422 错误，code = EPUB_PARSE_ERROR，且 workspace 下不残留任何目录（parse 在内存中完成，失败时不创建 book_id 目录）

#### Scenario: 解析成功但落盘失败
- **WHEN** EPUB 解析成功但在 write_meta / write_chapter 过程中发生 I/O 错误
- **THEN** 系统 SHALL `shutil.rmtree(book_dir)` 清理半成品目录后重抛原错误，workspace 下不残留残缺书

#### Scenario: 无有效章节
- **WHEN** EPUB 解析成功但过滤后 0 个章节（如诗集、短文，全部低于 word_count 阈值）
- **THEN** 返回 422 错误，code = EPUB_PARSE_ERROR，message 明确指出「无有效章节」，不创建 book_id 目录

### Requirement: List books
系统 SHALL 提供 GET /api/books 端点，返回所有已上传的书目列表。

#### Scenario: 有书
- **WHEN** workspace 下有 2 本书
- **THEN** 返回 `{"books": [{"book_id": "...", "title": "...", "author": "...", "status": "uploaded", "total_chapters": N}, ...]}`

#### Scenario: 无书
- **WHEN** workspace 为空
- **THEN** 返回 `{"books": []}`

### Requirement: Get book detail
系统 SHALL 提供 GET /api/books/{book_id} 端点，返回单本书的详细信息。

#### Scenario: 书存在
- **WHEN** 请求 GET /api/books/{book_id} 且该书存在
- **THEN** 返回 BookMeta 的完整 JSON（含 profiling 字段和 analysis_progress）

#### Scenario: 书不存在
- **WHEN** 请求 GET /api/books/{不存在的book_id}
- **THEN** 返回 404 错误，code = BOOK_NOT_FOUND

### Requirement: List chapters
系统 SHALL 提供 GET /api/books/{book_id}/chapters 端点，返回章节列表（不含正文）。

#### Scenario: 正常返回
- **WHEN** 请求 GET /api/books/{book_id}/chapters 且该书有 10 章
- **THEN** 返回 `{"chapters": [{"chapter_id": 1, "title": "...", "order": 1, "word_count": 5200}, ...]}`，按 order 排序

#### Scenario: 书不存在
- **WHEN** 请求 GET /api/books/{不存在的book_id}/chapters
- **THEN** 返回 404 错误，code = BOOK_NOT_FOUND

### Requirement: Async wrapping
所有 API 端点 SHALL 使用 `asyncio.to_thread()` 包装同步的 Filestore 调用，避免阻塞事件循环。EPUB 解析（同步函数）同样用 `asyncio.to_thread()` 包装。

#### Scenario: 非阻塞
- **WHEN** 客户端请求上传一个大 EPUB 文件
- **THEN** EPUB 解析在线程池中执行，事件循环不被阻塞

### Requirement: Analysis routes registration
`main.py` SHALL 注册 analysis router（`api/analysis.py`），替换现有的 501 stub 端点（/analyze, /progress, /analyze/stop, /cast, /chapters/{cid}/result 中的相关路由）。GET /api/meta/relation-types 和 GET /api/health 保持不变。

#### Scenario: 路由注册后可访问
- **WHEN** FastAPI app 启动后请求 POST /api/books/{id}/analyze
- **THEN** 不再返回 501，而是执行分析逻辑或返回 404/409/202

### Requirement: BookMeta status 更新
分析启动时系统 SHALL 将 `meta.status` 更新为 `analyzing` 并写入 `meta.json`。分析完成后更新为 `analyzed`（或全部失败时 `failed`）。`analysis_progress.mode` SHALL 设为 `few_long`，`chapters_done` 和 `chapters_failed` SHALL 反映实际结果。

#### Scenario: 启动分析时更新状态
- **WHEN** Orchestrator 启动分析
- **THEN** meta.json 中 status 变为 "analyzing"，analysis_progress.mode 变为 "few_long"

#### Scenario: 分析完成后更新状态
- **WHEN** 5 章全部成功分析
- **THEN** meta.json 中 status 变为 "analyzed"，chapters_done=[1,2,3,4,5]，chapters_failed=[]
