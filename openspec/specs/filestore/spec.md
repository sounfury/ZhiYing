## ADDED Requirements

### Requirement: Book directory management
系统 SHALL 在 workspace 下为每本书创建独立的目录结构 `{workspace_root}/{book_id}/`，包含子目录 `chapters/`、`ledger/`、`overrides/`。

#### Scenario: 创建新书目录
- **WHEN** 调用 `create_book_dir(book_id)` 且该目录不存在
- **THEN** 创建 `workspace/{book_id}/` 及其子目录 `chapters/`、`ledger/`、`overrides/`

#### Scenario: 目录已存在
- **WHEN** 调用 `create_book_dir(book_id)` 且该目录已存在
- **THEN** 不报错，确保目录结构完整

### Requirement: BookMeta persistence
系统 SHALL 将 BookMeta 序列化为 JSON 写入 `workspace/{book_id}/meta.json`，并从该文件反序列化读取。写入使用临时文件 + rename 保证原子性。

#### Scenario: 写入 meta
- **WHEN** 调用 `write_meta(book_id, meta)` 
- **THEN** meta.json 被写入，内容为 BookMeta 的 JSON 序列化

#### Scenario: 读取 meta
- **WHEN** 调用 `read_meta(book_id)` 且 meta.json 存在
- **THEN** 返回 BookMeta 对象

#### Scenario: meta 不存在
- **WHEN** 调用 `read_meta(book_id)` 且 meta.json 不存在
- **THEN** 抛出 AppError(BOOK_NOT_FOUND)

### Requirement: Chapter persistence
系统 SHALL 将 Chapter 序列化为 JSON 写入 `workspace/{book_id}/chapters/chapter_{id:03d}.json`，文件名使用 3 位零填充。

#### Scenario: 写入章节
- **WHEN** 调用 `write_chapter(book_id, chapter)` 且 chapter.chapter_id = 1
- **THEN** 写入 `chapters/chapter_001.json`

#### Scenario: 读取章节
- **WHEN** 调用 `read_chapter(book_id, 3)`
- **THEN** 读取 `chapters/chapter_003.json` 并返回 Chapter 对象

#### Scenario: 读取章节正文
- **WHEN** 调用 `read_chapter_content(book_id, 3)`
- **THEN** 返回 Chapter.content 字符串（不带其他元信息）

#### Scenario: 章节不存在
- **WHEN** 调用 `read_chapter(book_id, 999)` 且 chapter_099.json 不存在
- **THEN** 抛出 AppError(BOOK_NOT_FOUND)

### Requirement: Chapter listing
系统 SHALL 提供 `list_chapter_briefs(book_id)` 方法，返回所有章节的简要信息（chapter_id / title / order / word_count），不含正文内容。

#### Scenario: 列出章节
- **WHEN** 调用 `list_chapter_briefs(book_id)` 且该书有 5 个章节文件
- **THEN** 返回 5 个 ChapterBrief 对象，按 order 排序

### Requirement: Book listing
系统 SHALL 提供 `list_books()` 方法，扫描 `workspace/*/meta.json` 返回所有书目的 BookMeta 列表。

#### Scenario: 列出书目
- **WHEN** workspace 下有 3 个书籍目录，每个都有 meta.json
- **THEN** 返回 3 个 BookMeta 对象

#### Scenario: 忽略无 meta 的目录
- **WHEN** workspace 下有目录 A（含 meta.json）和目录 B（无 meta.json）
- **THEN** 只返回目录 A 对应的 BookMeta

### Requirement: Cast persistence
系统 SHALL 将 Cast 序列化为 JSON 写入 `workspace/{book_id}/cast.json`，并从该文件反序列化读取。cast.json 不存在时返回空 Cast。

#### Scenario: 写入 cast
- **WHEN** 调用 `write_cast(book_id, cast)` 
- **THEN** cast.json 被写入

#### Scenario: 读取已有 cast
- **WHEN** 调用 `read_cast(book_id)` 且 cast.json 存在
- **THEN** 返回 Cast 对象

#### Scenario: 读取空 cast
- **WHEN** 调用 `read_cast(book_id)` 且 cast.json 不存在
- **THEN** 返回 `Cast(version=0, persons=[])`

### Requirement: Ledger persistence
系统 SHALL 将 ChapterLedger 序列化为 JSON 写入 `workspace/{book_id}/ledger/chapter_{id:03d}.json`，并从该文件反序列化读取。

#### Scenario: 写入 ledger
- **WHEN** 调用 `write_ledger(book_id, ledger)` 且 ledger.chapter_id = 5
- **THEN** 写入 `ledger/chapter_005.json`

#### Scenario: 读取单个 ledger
- **WHEN** 调用 `read_ledger(book_id, 5)`
- **THEN** 读取 `ledger/chapter_005.json` 并返回 ChapterLedger 对象

#### Scenario: 读取多个 ledger
- **WHEN** 调用 `read_ledgers(book_id, [1, 2, 3])`
- **THEN** 返回 3 个 ChapterLedger 对象（已存在的），跳过不存在的章

### Requirement: Synchronous I/O
Filestore 的所有方法 SHALL 使用同步文件 I/O（`Path.read_text` / `Path.write_text`）。调用方（如 FastAPI 路由）应通过 `asyncio.to_thread()` 包装调用。

#### Scenario: 同步读取
- **WHEN** 在同步上下文中调用 `filestore.read_meta(book_id)`
- **THEN** 方法正常返回，不涉及 async/await

### Requirement: Atomic writes
系统 SHALL 在写入 JSON 文件时使用临时文件 + rename 策略，确保写入过程中断不会损坏已有文件。

#### Scenario: 原子写入
- **WHEN** 调用 `write_meta(book_id, meta)` 
- **THEN** 先写入临时文件 `meta.json.tmp`，成功后 rename 为 `meta.json`
