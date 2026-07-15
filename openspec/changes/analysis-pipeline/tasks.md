## 1. Agent 工具层（agent/tools.py）

- [x] 1.1 创建 `ChapterToolContext` 类：持有 book_id、chapter_id、cast_snapshot（只读 Cast）、cast_buffer（dict[str, CastPropose]）、filestore 引用、submit_ledger（ChapterLedger | None）
- [x] 1.2 实现 `read_chapter_window(offset: int, limit: int)` 工具：从 Filestore 读取当前章 content，按 offset/limit 切片，强制 limit ≤ settings.read_window_chars，返回固定 JSON `{chapter_id, segment_index, offset, limit, total_chars, has_more, text}`
- [x] 1.3 实现 `grep_in_chapter(keyword: str)` 工具：在当前章 content 中搜索关键词，返回命中行列表 `[{line_number, text}]`
- [x] 1.4 实现 `query_cast()` 工具：返回冻结的 cast_snapshot JSON（含 version、persons 列表）
- [x] 1.5 实现 `propose_cast_update(canonical_name, aliases, bio, gender, importance)` 工具：分配临时 `ch{cid}_p{n}` id，存入 cast_buffer，重复 canonical_name 返回已有 id
- [x] 1.6 实现 `submit_result(persons, relations, events, summary)` 工具：校验 type 枚举（is_valid_type）+ person_id 存在性（cast_snapshot ∪ cast_buffer）+ 自环检查；校验失败返回错误字符串；成功写入 submit_ledger 并返回 `{"status": "submitted"}`
- [x] 1.7 实现 `make_tools(ctx: ChapterToolContext) -> list[BaseTool]` 工厂函数：用 `@tool` 装饰器注册 5 个工具，返回 LangChain BaseTool 列表

## 2. Chapter Agent 运行时（agent/chapter_agent.py + agent/prompts/chapter.py）

- [x] 2.1 创建 `agent/prompts/chapter.py`：定义 `ChatPromptTemplate`，system prompt 包含角色描述、关系枚举（调用 `relation_summary_for_prompt()`）、工具使用纪律、出口约定；user prompt 变量含 chapter_meta、cast_summary、mode（inject/windowing）、content 或 windowing_instructions
- [x] 2.2 实现 `build_user_prompt(chapter, cast_snapshot, settings)` 函数：char_count ≤ inject_max_chars 时注入全文；否则注入元信息 + 建议窗数 + 分窗纪律提示
- [x] 2.3 实现 `run_chapter_agent(book_id, chapter_id, cast_snapshot, filestore, settings) -> AgentResult`：创建 ChapterToolContext → make_tools → ChatPromptTemplate → ChatOpenAI → LC tool-calling loop（max_agent_steps 控制，长章按窗数抬高）
- [x] 2.4 处理 Agent 循环退出：模型调用 submit_result 成功 → 返回 ledger + cast_buffer + summary；达到 max_steps 未 submit → 返回部分结果 + warning 日志
- [x] 2.5 Agent 产物落盘：将含临时 person_id 的 ChapterLedger 通过 Filestore.write_ledger 写入 ledger/chapter_{cid}.json；cast_buffer 保留在内存供 CastWriter

## 3. CastWriter（agent/cast_writer.py）

- [x] 3.1 创建 `CastWriter` 类：接受 filestore 引用，维护正式 person_id 计数器 `next_id`、临时→正式 映射表 `id_map: dict[str, str]`
- [x] 3.2 实现 `apply(chapter_id: int, cast_buffer: dict[str, CastPropose])` 方法：遍历 buffer 中的 propose，canonical_name 完全一致则合并到已有 person（别名取并集），否则分配新 `p00N` id；更新 id_map
- [x] 3.3 实现 `finalize()` 方法：将合并后的 cast 写入 cast.json（Filestore.write_cast）；调用 `rewrite_ledgers()` 用 id_map 替换所有 ledger 文件中的临时 person_id
- [x] 3.4 实现 `detect_conflicts() -> list` 方法：检测别名重叠但 canonical_name 不同的人物对，写入 merge_queue.json

## 4. Orchestrator（core/orchestrator.py）

- [x] 4.1 创建 `Orchestrator` 类：持有 book_id、filestore、settings、stop_flag（asyncio.Event）、progress_queue（asyncio.Queue）
- [x] 4.2 实现 `start(to_chapter: Optional[int])` 方法：读 meta → 校验 status != analyzing → 过滤分析章队列（include_in_analysis=true，可选 to_chapter 截断）→ 冻结 cast 快照 → 设 status=analyzing → 异步启动 `_run()`
- [x] 4.3 实现 `_run()` 方法：asyncio.Semaphore(max_parallel_chapters) 并行 run_chapter_agent → 每章完成后 push SSE progress 事件到 queue → barrier 等待全部
- [x] 4.4 单章失败处理：catch Agent 异常，记录 chapters_failed，push 失败事件到 queue，不阻塞其他章
- [x] 4.5 stop flag 检查：每章 Agent 启动前检查 stop_flag.is_set()，已 set 则跳过；已启动的等其自然完成
- [x] 4.6 barrier 后调用 CastWriter：对所有成功章按章序 apply cast_buffer → finalize（rewrite ledger + detect_conflicts → merge_queue）→ 更新 meta status=analyzed + analysis_progress

## 5. 分析 API（api/analysis.py）

- [x] 5.1 创建 `api/analysis.py` FastAPI router：实现 `POST /api/books/{book_id}/analyze` 端点，接受可选 `to_chapter: Optional[int]` query param；校验 book 存在（404）+ status 非 analyzing（409）→ 调用 orchestrator.start() → 返回 202
- [x] 5.2 实现 `GET /api/books/{book_id}/progress` SSE 端点：从 orchestrator.progress_queue 读取事件，用 `StreamingResponse` + `text/event-stream` 推送 `event: progress` / `event: done`
- [x] 5.3 实现 `POST /api/books/{book_id}/analyze/stop` 端点：set orchestrator.stop_flag → 返回 200 `{"status": "stopping"}`
- [x] 5.4 实现 `GET /api/books/{book_id}/cast` 端点：通过 Filestore.read_cast 返回 cast.json（不存在返回空 cast）
- [x] 5.5 实现 `GET /api/books/{book_id}/chapters/{chapter_id}/result` 端点：通过 Filestore.read_ledger 返回 ChapterLedger（不存在返回 404）
- [x] 5.6 在 `main.py` 中注册 analysis router，替换 501 stub 路由（/analyze, /progress, /analyze/stop, /cast, /chapters/{cid}/result）

## 6. 集成与验证

- [x] 6.1 确保 langchain-core 依赖安装（`@tool` 装饰器、`ChatPromptTemplate`、`BaseTool`）；更新 requirements.txt
- [x] 6.2 手动冒烟测试：准备一个短 EPUB → 上传 → POST /analyze → SSE 看进度 → GET /cast 验证人名册 → GET /chapters/1/result 验证 ledger
- [x] 6.3 测试空 cast 场景：不上传任何预设 cast，直接分析，验证 Agent 能 propose 新人并产出合法 ledger
- [x] 6.4 测试长章分窗场景：用超长章节 EPUB 验证 read_chapter_window 被正确调用、max_agent_steps 被抬高
