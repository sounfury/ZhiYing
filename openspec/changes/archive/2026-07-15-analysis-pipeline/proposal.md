## Why

ZhiYing 已有 EPUB 解析 + 数据模型 + Filestore + LLM Provider 等基础设施，但分析管线尚未实现。需要从零搭建四层（Agent 工具 → Chapter Agent → Orchestrator → API），使「上传 EPUB → 启动分析 → 查看人名册 / 章账本」的 P0 闭环可跑通。P0 聚焦 few_long 模式（全章并行 + 确定性预合并），不做 LLM Reconcile、不做 Aggregator 出图。

## What Changes

- **Agent 工具层** (`agent/tools.py`)：实现 5 个 LangChain `@tool` 工具——`read_chapter_window`（强制 limit ≤ `read_window_chars`，固定返回格式）、`grep_in_chapter`（章内搜索返回命中行）、`query_cast`（只读快照）、`propose_cast_update`（分配 per-chapter 临时 `ch{cid}_p{n}` id，存入 cast_buffer）、`submit_result`（type 枚举闸门 + person_id 存在性闸门，校验失败返回错误字符串给模型而非抛异常）
- **Chapter Agent 运行时** (`agent/chapter_agent.py` + `agent/prompts/chapter.py`)：LangChain tool-calling loop + `max_agent_steps` 控制；短章（`char_count ≤ inject_max_chars`）整章注入 prompt，长章只注入元数据 + 分窗纪律；空 cast 可跑（propose 新人 → submit 带临时 id）；产出含临时 person_id 的 ledger + summary + cast_ops
- **CastWriter** (`agent/cast_writer.py`)：顺序 apply 各章 cast_ops，分配正式 person_id，建立临时→正式 id 映射，canonical_name 完全一致则自动合并别名；同名不同别名冲突 → 写入 merge_queue.json 待人工
- **Orchestrator** (`core/orchestrator.py`)：薄编排——queue = `include_in_analysis=true` 的章（可选 `to_chapter` 截断）→ `asyncio.Semaphore` 并行执行 Chapter Agent → barrier → CastWriter 顺序 apply → ledger 文件 rewrite 临时 id 为正式 id → 程序对冲突做基本合并 → `status = analyzed`；防重入（`status==analyzing` 拒绝）；粗糙 stop flag
- **分析 API** (`api/analysis.py`)：`POST /api/books/{id}/analyze`（可选 `to_chapter` query param）→ 202 Accepted；`GET /api/books/{id}/progress` → SSE 逐章推送（每章完成 / 失败 / 全部结束）；`POST /api/books/{id}/analyze/stop`；`GET /api/books/{id}/cast`（返回 cast.json）；`GET /api/books/{id}/chapters/{cid}/result`（返回单章 ledger）

## Capabilities

### New Capabilities

- `agent-tools`: Chapter Agent 的 5 个 LangChain 工具实现——读窗、搜索、查 cast、propose 新人、提交结果，含校验闸门与临时 person_id 机制
- `chapter-agent`: 单章分析 Agent 运行时——LC tool-calling loop、提示词模板（关系短枚举 / 工具纪律 / 出口约定）、短章注入 / 长章分窗策略
- `cast-writer`: 人名册单写队列——顺序 apply cast_ops、分配正式 id、同名人名合并、临时→正式 id 映射与 ledger rewrite
- `orchestrator`: few_long 模式薄编排——并行调度 Chapter Agent、barrier 后 CastWriter apply、确定性预合并、防重入与状态管理、粗糙 stop flag
- `analysis-api`: 分析相关 API 端点——启动分析（可选 to_chapter）、SSE 进度推送、中断、查看 cast 与单章 ledger

### Modified Capabilities

- `book-api`: 新增分析相关端点（/analyze, /progress, /analyze/stop, /cast, /chapters/{cid}/result）及 ChapterLedger / Cast 的读取接口

## Impact

- **新增代码**：`backend/app/agent/tools.py`、`agent/chapter_agent.py`、`agent/cast_writer.py`、`agent/prompts/chapter.py`、`backend/app/core/orchestrator.py`、`backend/app/api/analysis.py`
- **修改代码**：`backend/app/main.py`（注册 analysis router）、`backend/app/models/book.py`（status 枚举增加 `analyzing`/`analyzed`）
- **依赖**：需安装 `langchain-core`（`@tool` 装饰器、`ChatPromptTemplate`）、`langchain-openai`（已装）
- **运行时**：LLM API key 必须配置（`LLM_API_KEY`），否则分析无法启动
- **不涉及**：Aggregator、GET /graph、前端改动、NLP Cast Pass、Memory Manager、many_chapters 波次模式
