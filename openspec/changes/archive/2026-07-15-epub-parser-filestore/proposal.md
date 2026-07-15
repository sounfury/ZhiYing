## Why

Bootstrap 基础设施已落地（FastAPI 脚手架、配置、错误处理、关系 SSOT、LLM Provider、Pydantic 模型骨架），但所有 API 路由仍返回 501。要进入「上传 EPUB → 解析章节 → 分析」的主链路，第一步必须打通 EPUB 解析器和 workspace 存储层——这是 Agent 工具（get_chapter_text / grep_in_chapter）和 API 路由的共同底层。

## What Changes

- **新增 `storage/filestore.py`**：workspace/{book_id}/ 的同步读写层，管理 meta.json / chapters/*.json / cast.json / ledger/*.json 的序列化与反序列化；API 层用 asyncio.to_thread 包装
- **新增 `core/parser.py`**：用 ebooklib + BeautifulSoup4 解析 EPUB，分层降级切章（spine 粒度 → heading 切分 → 正则 fallback），HTML 清洗保留段落，中文字符计字数，产出 BookMeta + Chapter[]
- **调整 `models/book.py`**：BookMeta 新增 `source_file`（原始 EPUB 文件名）；Chapter 新增 `source_href`（原始 EPUB spine item 标识）
- **实现 API 路由**：POST /api/books/upload（接收 EPUB 文件，调 parser，落盘），GET /api/books（扫 workspace 列书），GET /api/books/{id}（书籍详情），GET /api/books/{id}/chapters（章节列表，不含正文）
- **引入 Filestore 单例**：在 config 或 main.py 中初始化一个全局 Filestore 实例，供 API 路由和后续 Agent 工具共享

## Capabilities

### New Capabilities

- `epub-parser`: EPUB 文件解析——元数据提取、分层降级切章、HTML 清洗为纯文本、中英文字数统计、profiling 计算
- `filestore`: workspace 目录的同步文件 I/O 层——meta/chapters/cast/ledger 的读写，书目扫描，文件路径管理
- `book-api`: 书籍相关 REST 端点——上传 EPUB、书目列表、书籍详情、章节列表

### Modified Capabilities

- `data-models`: BookMeta 新增 source_file 字段，Chapter 新增 source_href 字段（支持解析结果溯源）

## Impact

- **新增代码**：`backend/app/storage/filestore.py`、`backend/app/core/parser.py`、`backend/app/api/books.py`
- **修改代码**：`backend/app/models/book.py`（加字段）、`backend/app/main.py`（拆路由到 api/books.py）
- **新增依赖**：无（ebooklib / beautifulsoup4 / lxml 已在 requirements.txt）
- **API 变化**：4 个端点从 501 变为可用（upload / list / detail / chapters）
- **不涉及**：Agent 工具层、Orchestrator、Aggregator、SQLite、前端
