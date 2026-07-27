## Context

ZhiYing 后端骨架（bootstrap-infrastructure）已落地：FastAPI 入口、配置系统、错误处理、关系枚举 SSOT、LLM Provider（LangChain ChatOpenAI）、Pydantic 模型骨架（BookMeta / Chapter / Cast / ChapterLedger / GraphData）均已就位。但所有 API 路由仍返回 501，workspace 存储层是空的 `storage/__init__.py`，`core/parser.py` 不存在。

要进入主链路「上传 EPUB → 解析章节 → 章级分析 → 出图」，必须先打通底层：EPUB 解析器和 workspace 文件存储层。这两个模块也是后续 Agent 工具（get_chapter_text / grep_in_chapter / submit_result）的直接调用对象。

ARCHITECTURE §2.2.1 明确：本机个人项目，P0 不做 path jail / SQLite catalog / jobs 框架。状态扫 meta.json 即可。

## Goals / Non-Goals

**Goals:**

- EPUB → (BookMeta, Chapter[]) 的完整解析链路，包括元数据提取、per-spine-item 分层切章、HTML 清洗、字数统计、profiling
- Filestore：workspace/{book_id}/ 的唯一同步读写层，管理所有 JSON 文件的序列化与路径
- 4 个书籍 API 端点从 501 变为可用（upload / list / detail / chapters）
- BookMeta 和 Chapter 各加一个溯源字段（source_file / source_href）

**Non-Goals:**

- Agent 工具实现（get_chapter_text / grep_in_chapter 等——后续 change）
- Orchestrator / Aggregator / 分析流程
- SQLite（P0 全 JSON + 扫目录）
- 前端实现
- cast.json / ledger/ 的写入逻辑（Filestore 提供接口，但写时机由分析流程控制）
- path jail / 全局 catalog

## Decisions

### 1. Filestore 全同步 I/O，API 层用 asyncio.to_thread 包装

**选择：** 同步（`Path.read_text` / `Path.write_text`）

**理由：**
- ebooklib 本身是同步的，Parser 也只能是同步函数
- Agent 工具（LangChain @tool）在同步上下文中调用
- 本机个人项目，文件不大，异步 I/O 的吞吐优势可忽略
- 避免 aiofiles 额外依赖

**替代方案：** 全异步（aiofiles）—— 与 FastAPI 风格一致但增加依赖和复杂度，收益不匹配。

### 2. P0 不用 SQLite，状态全存 meta.json

**选择：** JSON 文件 + 扫目录

**理由：**
- ARCHITECTURE §2.2.1 明确「书目列表扫 workspace/*/meta.json 即可」
- 章状态可从文件存在性推断：ledger/chapter_003.json 存在 = done
- 分析进度存在 BookMeta.analysis_progress 里
- 单书数据量小，扫目录不构成性能问题

**替代方案：** P0 就建 chapters_status 表——ARCHITECTURE §9.2 描述了它，但 §2.2.1 将其归入 P2。

### 3. Parser 与 Filestore 职责分离

**选择：** `parse_epub()` 返回 `(BookMeta, list[Chapter])` 模型对象，不直接写文件。落盘由调用方（API 路由）通过 Filestore 完成。

**理由：**
- Parser 可独立测试（输入文件，输出模型）
- Filestore 可独立测试（输入模型，输出文件）
- 同一 Parser 结果可被不同存储策略消费

### 4. 切章策略：per-spine-item 分层降级

**选择：** 对**每个 spine item 独立**做分层检测，而非全书先二选一。

**per-item 层次：**
```
for each spine item:
  1. 若内部有多个 <h1>/<h2> heading → 按 heading 位置切成多章
  2. 否则若正文匹配「第X回/Chapter N」多处 → 正则切
  3. 否则 → 整个 item 作为一个 Chapter
```
切完后统一过滤 `word_count < min_chapter_words`，再按序重编号 `chapter_id = order`。

**为什么不按「spine 数 > 3」做全书二选一：**
- 很多「一文件一章」的 EPUB 里，每章仍有一个 `<h1>` 标题——若先看 heading 再决定是否一切一文件，逻辑会拧
- 「文本量合理」没有可靠阈值（字数上下界？），不可测
- per-item 分层天然兼容：结构好的走 1 或 3，结构差的走 2，不会互相干扰
- spine item 数量只适合做启发式提示（例：判断 TOC 是否可信），不宜当硬闸门

**理由：** EPUB 结构千差万别，per-item 分层让每个 item 自己选最合适的切法，互不干扰。

### 5. 字数统计：中文字符数 + 英文词数

**选择：** 去空白和标点后，中文字符按字计，英文按空格分词计，两者之和为 word_count。

**理由：** 中文「这章有多长」的直觉是字数而非词数。纯 `len(content)` 会把英文空白也算入，偏大。

### 6. HTML 清洗：去标签 + 保留段落

**选择：** BeautifulSoup 去所有标签，`<p>` / `<br>` / `<div>` 转为 `\n\n`，解码 HTML 实体（`&amp;` → `&` 等）。

**不做：** 不去脚注 / 注释 / 版权声明等噪声（P0 够用，过度清洗增加复杂度且可能误删正文）。

### 7. Filestore 单例：storage/filestore.py 懒加载

**选择：** 在 `storage/filestore.py` 模块内提供 `get_filestore()` 懒加载函数，首次调用时从 `settings.workspace_path` 创建单例。API 层通过 `Depends(get_filestore)` 注入；Agent 工具直接 `from app.storage.filestore import get_filestore` 调用。

```python
# storage/filestore.py
_filestore: Filestore | None = None

def get_filestore() -> Filestore:
    global _filestore
    if _filestore is None:
        _filestore = Filestore(settings.workspace_path)
    return _filestore
```

**理由：**
- Agent 工具（LangChain @tool）在同步上下文中调用，无法走 FastAPI Depends——懒加载函数是唯一能同时服务 API 和 Agent 的方式
- 不需要在 main.py lifespan 里手动 set，减少耦合
- `settings` 已是模块级单例，`get_filestore()` 同理

**替代方案：**
- `app/deps.py` + FastAPI Depends — API 层好用，但 Agent 工具拿不到 Depends 上下文
- main.py lifespan set 全局变量 — 需要额外协调启动顺序，且 Agent 工具还是要找全局引用

### 8. 上传失败时清理半成品

**选择：** 先完整 parse 成功，再 create_book_dir + 批量 write。若 parse 失败则直接抛错，不创建任何目录。若 write 阶段失败，`shutil.rmtree(book_dir)` 清理后重新抛错。

**流程：**
```
1. parse_epub(file_bytes) → (meta, chapters)     # 纯内存，不写盘
   失败 → 直接抛 EPUB_PARSE_ERROR，无半成品
2. chapters 为空 → 抛 EPUB_PARSE_ERROR("无有效章节")
3. create_book_dir(book_id)                       # 此时才创建目录
4. write_meta + write_chapter × N                 # 批量落盘
   任一失败 → rmtree(book_id) → 重抛原错误
```

**理由：**
- parse 与落盘分离（Decision 3 已定），天然可以先 parse 完再看结果
- 避免半成品 `workspace/{book_id}/` 残留，导致 `list_books()` 扫到残缺书
- rmtree 是兜底；正常路径下 write 本身用原子 rename，单文件不会损坏

## Risks / Trade-offs

- **[EPUB 结构极端多样]** → per-item 分层降级有兜底，但不能保证 100% 正确切章。P0 可接受不完美；用户上传后可在前端看到章节列表，异常时手动反馈。
- **[短章阈值对诗集/短文过猛]** → 默认阈值 200 可能将诗集全部过滤为 0 章。系统在 0 章时抛 EPUB_PARSE_ERROR 而非静默成功；用户可调 min_chapter_words=0 重试。
- **[上传中途失败留半成品]** → 先完整 parse 成功再 create_book_dir + 批量 write；落盘阶段失败 rmtree 清理。
- **[同步 I/O 阻塞事件循环]** → API 层全用 `asyncio.to_thread()` 包装，Filestore 本身不涉及 async。
- **[无 SQLite → 状态一致性靠文件]** → 单进程本机场景下文件 I/O 不会并发冲突。meta.json 写入用临时文件 + rename 保证原子性。
- **[word_count 定义不精确]** → 中英混合文本（如注释中夹英文）的计数可能偏大，但仅用于 profiling 和展示，不影响分析质量。
