## 1. Model adjustments

- [x] 1.1 BookMeta 新增 `source_file: str = ""` 字段（models/book.py）
- [x] 1.2 Chapter 新增 `source_href: str = ""` 字段（models/book.py）

## 2. Filestore

- [x] 2.1 创建 `storage/filestore.py`，定义 `Filestore` 类，接收 `workspace_root: Path`，实现 `create_book_dir(book_id)` 创建目录结构（chapters/ ledger/ overrides/）
- [x] 2.2 实现 `write_meta(book_id, meta)` 和 `read_meta(book_id)` — JSON 序列化 + 临时文件 rename 原子写入；read 不存在时抛 AppError(BOOK_NOT_FOUND)
- [x] 2.3 实现 `write_chapter(book_id, chapter)` 和 `read_chapter(book_id, chapter_id)` — 文件名 `chapter_{id:03d}.json`；`read_chapter_content(book_id, chapter_id)` 只返回 content 字符串
- [x] 2.4 实现 `list_chapter_briefs(book_id)` — 扫描 chapters/ 目录，返回 ChapterBrief 列表，按 order 排序
- [x] 2.5 实现 `write_cast(book_id, cast)` 和 `read_cast(book_id)` — cast.json 不存在时返回空 Cast(version=0, persons=[])
- [x] 2.6 实现 `write_ledger(book_id, ledger)` 和 `read_ledger(book_id, chapter_id)` — 文件名 `chapter_{id:03d}.json`；`read_ledgers(book_id, chapter_ids)` 批量读取，跳过不存在
- [x] 2.7 实现 `list_books()` — 扫描 workspace/*/meta.json，返回 BookMeta 列表，忽略无 meta.json 的目录
- [x] 2.8 实现 `get_filestore()` 懒加载函数 — 模块级 `_filestore` 单例，首次调用时从 `settings.workspace_path` 创建；API 层用 Depends 注入，Agent 工具直接 import 调用

## 3. EPUB Parser

- [x] 3.1 创建 `core/parser.py`，定义 `parse_epub(file_path, *, min_chapter_words=200)` 入口函数，用 ebooklib 读取 EPUB
- [x] 3.2 实现元数据提取：从 OPF metadata 读 dc:title / dc:creator，填充 BookMeta.title / author / source_file
- [x] 3.3 实现 HTML 清洗：BeautifulSoup 去标签，`<p>`/`<br>`/`<div>` 转 `\n\n`，解码 HTML 实体
- [x] 3.4 实现字数统计：去空白标点后中文字符按字计 + 英文按空格分词计
- [x] 3.5 实现 per-spine-item 分层切章：对每个 spine item 独立执行——(1) 内部多个 `<h1>`/`<h2>` → 按 heading 切；(2) 正文匹配 `第[\d一二三四五六七八九十百千]+[章回节卷]` / `Chapter\s+\d+` 多处 → 正则切；(3) 以上均不匹配 → 整 item 一章。不按 spine 数做全书二选一
- [x] 3.6 实现章节标题提取：heading 文本 > `<title>` 标签 > 正则匹配文本 > "第N章" > "未命名"
- [x] 3.7 实现短章过滤 + 重编号：过滤 word_count < min_chapter_words 的片段；剩余章节按序重编号 chapter_id = order = 1..N（连续不跳号）；若过滤后 0 章 → 抛 AppError(EPUB_PARSE_ERROR)
- [x] 3.8 实现 profiling 计算：total_words / max_chapter_words / median_chapter_words 填入 BookMeta
- [x] 3.9 实现 source_href 追踪：每个 Chapter 记录来源 spine item 的 href 或 id

## 4. API routes

- [x] 4.1 创建 `api/books.py`，定义 `router = APIRouter(prefix="/api/books", tags=["books"])`
- [x] 4.2 实现 `POST /upload` — 接收 UploadFile，校验 .epub 后缀，生成 uuid book_id；先 asyncio.to_thread 调 parse_epub（纯内存），成功后再 create_book_dir + 批量 write；落盘阶段失败则 shutil.rmtree 清理后重抛；返回 book_id + title + total_chapters
- [x] 4.3 实现 `GET /` — asyncio.to_thread 调 filestore.list_books()，返回书籍列表
- [x] 4.4 实现 `GET /{book_id}` — asyncio.to_thread 调 filestore.read_meta()，返回 BookMeta JSON
- [x] 4.5 实现 `GET /{book_id}/chapters` — asyncio.to_thread 调 filestore.list_chapter_briefs()，返回章节列表
- [x] 4.6 将 books router 注册到 main.py，移除 main.py 中对应的 501 内联路由（upload / list / get_book / list_chapters）

## 5. Verification

- [x] 5.1 用项目根目录的 epub 文件测试上传，确认返回正确的 book_id 和章节数
- [x] 5.2 检查 workspace/{book_id}/ 目录结构：meta.json + chapters/chapter_001.json 等
- [x] 5.3 调用 GET /api/books 和 GET /api/books/{id}/chapters 确认数据一致
- [x] 5.4 确认 main.py 可正常启动（无导入错误），OpenAPI 文档 /docs 显示新端点
- [x] 5.5 测试失败路径：上传损坏文件确认无半成品目录残留；上传极短文确认返回 EPUB_PARSE_ERROR 而非 total_chapters=0
