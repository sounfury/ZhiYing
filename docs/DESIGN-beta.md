# ZhiYing 内测设计（DESIGN-beta）

| 项 | 内容 |
|---|---|
| 依据 | [PRD-beta](./PRD-beta.md)（内测产品行为唯一来源） |
| 状态 | 待评审；PRD-beta 中尚未实现的能力的设计 |
| 分工 | 写法同 [DESIGN](./DESIGN.md)，只写系统怎么做；产品规则只引用 PRD-beta 章节。某项做完后并入 DESIGN 对应章节，并从本文删除 |

---

## 0. 实施现状

| PRD-beta | 能力 | 状态 |
|---|---|---|
| §5 | PNG 导出 | 已实现：`frontend/src/components/GraphView/exportPng.ts`（按当前场景用 Canvas 重画，带书名、范围、图例、水印，按画布上限自动降倍数） |
| §3 | 示例书 | 已实现：`ExampleBooks`、`bookLinks.ts`（`?example=slug&focus=&chapter=&chapter_mode=`），书架「示例」分组，访客只读 |
| §4.1–4.2 | 账号与按用户隔离 | 已实现，见 DESIGN §5.5 |
| §4.3 | 用量上限 | **未实现** → §1 |
| §4.4 | 秒传 | **未实现**，原 DESIGN §5.4 方案移入并补全 → §2 |
| §6 | 反馈 | **未实现** → §3 |
| §7 | TXT 上传 | **未实现** → §4 |

评审结论（2026-10-14）已写入正文与 PRD-beta v0.5。

---

## 1. 用量上限

### 1.1 配置

全部放 `zhiying.quota.*`（`ZhiYingProperties`），不设管理界面：

| 键 | 含义 | 0 表示 |
|---|---|---|
| `max-books` | 每人书数（不含示例条目） | 不限 |
| `max-analysis-chars` | 每人累计分析字数 | 不限 |
| `max-file-size` | 单个上传文件（`DataSize`） | — |
| `max-concurrent-tasks` | 每人同时运行的任务（整书 + 单章重跑） | 不限 |
| `daily-token-budget` | 全站每日 token | 不限 |
| `time-zone` | 「当天」的时区，默认 `Asia/Shanghai` | — |

`spring.servlet.multipart.max-file-size`（现为 200MB）作为硬上限，须不小于 `max-file-size`；应用层先按 `max-file-size` 拒绝，返回可读的提示。

### 1.2 存储：用量流水

新表 `usage_ledger`，只追加、结算时更新一次，**不对书建外键、删书和清空分析时不删**，这样就实现了「删除不退还」。如果改成在 `analysis_task` 上加列，删书时任务会一起被删掉，用量也就跟着退回了，所以单独建表。

| 列 | 说明 |
|---|---|
| `task_id` | 主键，一个任务一行 |
| `user_id` | 发起者 |
| `item_id` | 书 ID；秒传上线后改为书架条目 ID（迁移后旧条目 ID = 书 ID，列不用改） |
| `chars` | 计入额度的字数 |
| `tokens` | 本任务总 token |
| `started_at` / `settled_at` | 结算前 `settled_at` 为空 |

- 每人已用字数 = `SUM(chars) WHERE user_id = ?`
- 今日 token = 当天 `started_at` 的 `SUM(tokens)`，加上内存中运行任务的实时 token（`ModelCallControl` 已在累计）
- 书数 = 本人书架条目数（不含示例）

### 1.3 领域对象

`domain/quota`：`QuotaLimits`（各上限）与 `UsageSnapshot`（已用书数、已用字数、本人运行中任务数、今日 token）。判断规则写在 `UsageSnapshot` 上，均为纯函数，结果是 `sealed interface QuotaCheck { Allowed; Exceeded(item, needed, remaining) }`：

- `checkUpload(fileBytes, isReuse)`：文件大小 → 书数（秒传同样计书数）
- `checkAnalysis(chars)`：全站预算 → 同时任务数 → 剩余字数；整本超出就整本拒绝，不做部分分析

### 1.4 用例顺序

**上传**（`ImportBook`）：读本人用量 → `checkUpload` → 解析 / 秒传判定 → 保存。自己书架上已有同一个文件时直接返回那本，不检查额度。

**启动分析**（`AnalysisRunner.launch`，在已有的 `synchronized(runs)` 登记锁内完成，避免同一用户并发启动时超额）：

1. 算待读字数：整书分析为「没有可沿用抽取的章」的 `wordCount` 之和（现在 `reusable()` 在任务线程里才算，需要提到启动前；它只读数据，可以提前），`force` 时为全部章；单章重跑为该章字数
2. 读本人用量与今日 token → `checkAnalysis`
3. 写流水行，`chars` = 待读字数（先预占）
4. 起任务线程
5. 任务结束时结算：`chars` 改为实际计费字数：已开始读的章（含读失败、被取消时正在读的）计入，没开始读的不计，复用的章不计，`tokens` 写本任务总量

`AnalysisRun` 记录发起者 ID，用来统计「本人运行中任务数」。服务重启时，`interruptRunning` 一并结算未结算的流水（按 `analysis_task_chapter` 已开始读的章重算）。

**全站预算**只在启动时判断，运行中的任务不中断（PRD-beta §4.3）。

### 1.5 接口与前端

- `GET /api/me/usage` → `{books: {used, limit}, chars: {used, limit}}`；书架顶部显示「已用 / 总额」，limit 为 0 时不显示该项
- 新增错误码：`QUOTA_EXCEEDED`（消息写明哪一项超出、还剩多少，例如「分析字数不足：本书需 16.1 万字，剩余 3.2 万字」）、`DAILY_BUDGET_EXHAUSTED`（「今日分析名额已满，请明天再试」）、`FILE_TOO_LARGE`；前端直接展示消息
- 管理员跳过书数、字数、同时任务数三项检查，文件大小与全站预算照常检查；流水照常写

---

## 2. 秒传

产品规则见 PRD-beta §4.4。做法是「多个书架条目指向同一本书，有人要改就先分叉」，命中时不复制整份数据。不复制的理由：章节 ID 全局唯一，结果版本 JSON 里到处引用章节 ID，复制就得整体改写 ID；而且每人一份正文和抽取记录会让存储随用户数线性增长，而大多数秒传的书根本不会被改。

### 2.1 前置：版本可判定

现在书和结果版本都没有记录「用的是哪版方法」，要先补上：

| 补什么 | 做法 |
|---|---|
| 导入版本 | `books.import_version`；常量 `IMPORT_VERSION`，EPUB 切章、清洗、章节选择规则一改就加 1。TXT 的分章方案另记在 `books.split_rule`（§4.3）。已有书迁移为 1 |
| 分析方法版本 | `analysis_revision.method_version`：由各调用点的模型 ID 与提示版本拼成摘要（读章已经有 `prompt_version`，后处理与团体归纳要补版本常量）。自动生成，不手动维护：手动版本号容易忘了加，旧方法的错误会经秒传扩散；代价是换模型后旧结果都不能秒传，这正是 PRD「当前版本的分析方法」的要求 |
| 整书完整 | `analysis_revision.full_book`：由 FULL 任务产生、未限定 `toChapter`，且 `analyzedChapters` 覆盖全部参与分析的章 |

旧结果没有这些字段，视为不可秒传。`AnalysisRevision.reusableFor(currentMethod)` 是纯判断，写在领域对象上。

### 2.2 书架条目

新表 `shelf_items` 取代 `book_owners`：

| 列 | 说明 |
|---|---|
| `id` | 主键；对外接口里的「书 ID」从此都是条目 ID |
| `user_id` | 所有者 |
| `book_id` | 当前指向的书 |
| `pending_book_id` | 分叉后、首次发布前的新书；平时为空 |
| `original_name`、`created_at` | 上传文件名、时间 |

迁移：每条 `book_owners` 生成一个条目，**条目 ID = 书 ID**，这样已有链接、示例配置（slug → ID）和前端缓存都不用动。

应用层统一把条目解析成实际的书：图与结果读 `book_id`；任务、进度、SSE 优先读 `pending_book_id`。权限只看条目。

### 2.3 命中判定（上传用例内，导入之前）

1. 服务器对上传内容算 SHA-256（即现有源文件摘要），不接受客户端提供的摘要。本人已有指向同一摘要的条目时，直接返回该条目（`existing: true`）
2. 候选书：源文件摘要相同、`import_version` 为当前版本、`split_rule` 与本次上传自动选出的方案相同、已发布结果满足 `reusableFor`、没有运行中的任务
3. 有多本符合时取最近发布的一本。命中就只新增一个条目（`reused: true`），不导入、不调模型、不记分析用量，但计入书数；没命中就照常导入
4. 判定与新增条目都在候选书的任务登记锁内完成，与「启动任务」互斥。所以书在运行任务时不会被命中，任何任务发布时，它所在的书只有发起者一个条目

前端根据 `reused` 提示「这本书已有分析结果，已直接加载」，并直接进入图，不显示进度。

### 2.4 共享与分叉

一本书被不止一个条目引用就算共享。只有一个条目时，所有操作原地进行，和现在一样。共享书上的写操作要先分叉：

1. 从同一源文件重新导入为新书（新章节 ID）。同一文件、同一导入版本，章节一一对应，按顺序复制原书各章的当前抽取（清空分析时不复制）。每条抽取只引用本章（`ChapterExtraction` 和 `EvidenceRef` 都校验「属于本章」），复制时把章节 ID 换成新章的 ID 即可。全程不调模型
2. 整书分析 / 单章重跑在新书上进行，按 DESIGN §5.2 的复用规则决定重读哪些章；用量按实际读取记在发起者名下（§1）
3. 新书首次发布前，条目仍指向原书（用户看到的是上一版），新书 ID 记在 `pending_book_id`；在发布事务内把条目改指新书。失败或取消时条目不动，分叉书保留，下次启动时复用已读的章。清空分析不产生发布，直接切换
4. 删除条目时，书已没有任何条目（含 `pending_book_id`）引用才真正删书；源文件仍按 DESIGN §5.1 处理

书详情里的「累计 token」改成从 `usage_ledger` 按条目统计，只显示本人的用量。秒传条目显示 0，不暴露原分析者的信息（PRD-beta §4.4「隐私」）。

示例书是管理员条目的来源属性，公开链接指向示例条目。管理员更新示例书时如果触发分叉，链接会随条目切到新书，已秒传的用户仍看旧版。反馈挂在条目与结果版本上，共享书的反馈按实际的书汇总给管理员（§3）。

### 2.5 第二步（待做）：按章正文跨书复用抽取

把 DESIGN §3.3「章抽取」的复用从同一本书扩大到所有书，键为章正文摘要 + 抽取输入摘要 + 模型与提示版本。章阅读的输入含滚动人名册快照（DESIGN §3.1），只有前面各章也一致时输入才相同，所以实际覆盖的是「正文相同、封面或元数据不同」的文件，以及同一版本在改动处之前的章。后处理与团体归纳照常执行。

---

## 3. 反馈

只收集，不改结果（PRD-beta §6）。

### 3.1 模型与存储

`domain/feedback/Feedback`：构造时校验不变量（类别取值合法、说明 ≤ 200 字、非通用反馈必须有书和对象）。

表 `feedback`：

| 列 | 说明 |
|---|---|
| `id`、`created_at` | — |
| `user_id` | 提交者，必填；访客点击「这里不对」时提示登录 |
| `item_id`、`book_id` | 条目与提交时实际的书；通用反馈为空 |
| `revision_id` | 提交时看到的结果版本 |
| `target_kind` | `PERSON` / `RELATION` / `GROUP` / `GENERAL` |
| `target_ref` | 人物 ID；关系键（两端人物 ID 与类型 ID，以 `/` 连接）；团体 ID |
| `target_label` | 提交时的显示名快照，例如「甲—乙：师徒」。团体每次分析都会重新归纳，ID 不稳定，管理员列表靠这个快照来读 |
| `category` | `DUPLICATE_PERSON` / `WRONG_RELATION` / `WRONG_GROUP` / `MISSING` / `OTHER`，可空 |
| `note` | 可空 |
| `scope` | 当前分析范围：`all` / `single:N` / `upto:N` |

人物 ID 和关系键在重跑后保持稳定（DESIGN §5.3），所以跳转时用当前版本定位；对象已不存在就提示「该对象在当前结果中已不存在」。

### 3.2 接口

- `POST /api/books/{id}/feedback`、`POST /api/feedback`（通用反馈）：先检查条目读权限，再保存。同一对象可以重复提交，不去重
- `GET /api/admin/feedback?book=`：按书列出，需要管理员身份
- `GET /api/admin/feedback/export?book=`：JSONL 格式，每行是一条反馈加上对象快照，供人工整理成评测样本（DESIGN §7）；不自动转换成评测集
- 管理员能看到所有书的反馈，但私有书只给反馈本身（书名、`target_label`、类别、说明），不给跳转链接，也不放开读书权限（PRD §5.12）；示例书照常跳转

### 3.3 前端

- 人物详情、关系详情、势力块上各加一个「这里不对」按钮，打开一个小表单（类别单选、一句说明、提交）；顶部栏加通用反馈入口。提交后用 toast 提示「已收到」
- 管理员新增 `/feedback` 页（与 `/eval` 同级）：按书分组列出反馈，示例书的反馈点击后通过 `bookLinks.ts` 生成 `focus=人物` 链接跳转，关系类反馈聚焦到其中一端的人物；私有书的反馈只列内容

shortcut：不做提交频率限制。内测是邀请制，滥用的风险低；以后如果开放访客提交，再加每人或每 IP 的每日上限。

---

## 4. TXT 上传

### 4.1 解析

在 infrastructure 层新增 `TxtParser`，与 `ZhiYingEpubParser` 一样产出 `ParsedBook`。`ImportBook` 按扩展名（`.epub` / `.txt`）选择解析器，其余流程（保存源文件、建书、分析、出图、导出）不变。EPUB 切章（`ChapterSplitter`）不动。

1. **编码**：有 BOM 时按 BOM 识别（UTF-8 / UTF-16）；否则先严格按 UTF-8 解码（遇到非法字节就报错），失败再用 GB18030 解码（GBK / GB2312 的超集）；仍失败则抛 `UNREADABLE_BOOK`。shortcut：不识别 Big5，因为 GB18030 解码 Big5 字节不报错，只会得到乱码，以后如果遇到繁体书源再加中文字符比例检测
2. **清洗**：统一换行符，去掉行尾空白，连续空行合并；行首缩进保留到切章之后（全角空格缩进是「这是正文段落」的信号）
3. **切章**：按 §4.2 的分章方案
4. **书名**取文件名去掉扩展名，作者为空

### 4.2 分章方案

照搬阅读类 App 的成熟做法（Legado「TXT 目录规则」、TRNovel `toc_rules.json`）：一组预置的「按行匹配标题」正则，上传时自动选一种，用户可改选。

方案放在资源文件 `infrastructure/.../txt-toc-rules.json`，字段沿用 Legado 的形状（`id`、`name`、`rule`、`example`），新增方案只改这个文件。`id` 一经发布不改，书记录的是 `id`；要改某条正则就新建一个 `id`，旧的保留，避免已有书的「当前方案」含义悄悄变化。Legado 是 GPL-3.0，正则按这些常见格式自己写，不整份拷贝它的 JSON。

首版预置（按优先级排列）：

| id | 名称 | 匹配示例 |
|---|---|---|
| `zh-chapter` | 第 X 章 / 回 / 节 / 话 | 「第一章 罗峰」「第 12 回」「第一百零三章」 |
| `zh-volume-chapter` | 卷 + 章 | 「第一卷 魔性不改」下面跟「第一章」 |
| `zh-special` | 第 X 章 + 序章、楔子、番外、尾声等 | 「楔子」「番外一 xx」「后记」 |
| `number` | 数字序号 | 「1、标题」「001 标题」「一、标题」 |
| `en-chapter` | 英文 | 「Chapter 1」「Part II」 |
| `bracket` | 符号括起的标题 | 「【第一章】」「☆、标题」 |
| `length` | 按长度分段 | 约 `zhiying.import.txt-segment-chars`（默认 10000）字一段，在附近段落边界切开，标题「第 N 段」 |

所有正则方案共用的抗误报约束（来自 TRNovel）：标题独占一行，行首只允许半角空白（全角空格缩进视为正文）；去掉缩进后长度 ≤ 35；以句号、问号结尾的行不算；排除计数词歧义（「第三部分」「第二节课」「第一部门」）。

切分规则：

- 卷标题行不单独成章，拼到下一章标题前（「第一卷 xx · 第一章 yy」）
- 第一个标题之前的内容保留为「开篇」一章，是否参与分析交给现有 `ChapterInclusion`（书名、简介这类短内容自然会被排除）
- 只有标题没有正文的章并入下一章

**自动选择**：按上表顺序逐个试切，取第一个满足「章数 ≥ 2 且平均章长在 `zhiying.import.txt-auto-chapter-chars`（默认 500–50000）之间」的方案；都不满足用 `length`。按顺序取第一个而不取命中最多：数字序号类规则容易把正文里的列表也算进去，命中数反而最多。

### 4.3 存储与改选

- `books.split_rule`：当前方案 `id`；EPUB 为空。`split_rule = length` 时书详情提示「未识别到章节标题，已按长度分段」
- `GET /api/books/{id}/split-preview`：对源文件跑每种方案，返回章数与开头、中间、结尾各 3 章标题，标出当前方案。纯计算，不落库
- `POST /api/books/{id}/split {rule}`：在 `AnalysisRunner.whileIdle` 内重新切章，同一事务里清空分析（复用 `BookRemoval` 的清空）、替换章节（新章节 ID）、更新 `split_rule` 与书的统计字段。权限同清空分析（书主；示例书仅管理员）。不调模型，不计额度
- 共享书（§2.4）上改选等于「清空分析 + 换方案」的分叉：从源文件按新方案导入新书，条目立即切换
- 前端：上传 `accept` 加 `.txt`；书详情显示当前方案和「换一种分章」，弹窗里列出预览，已有分析结果时确认文案写明「会清空现有分析，已用额度不退还」

shortcut：不支持用户自定义正则与多方案组合（PRD-beta §7「不做」）；以后要做，就是在资源文件之外再读一份用户规则，接口不变。
