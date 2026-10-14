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
| §4.3 | 用量上限 | 已实现，见 DESIGN §5.6 |
| §4.4 | 秒传 | 已实现第一版，见 DESIGN §5.4；按章正文跨书复用仍待做 → §2.5 |
| §8 | 后台管理 | **未实现** → §5 |
| §6 | 反馈 | **未实现** → §3 |
| §7 | TXT 上传 | **未实现** → §4 |

评审结论（2026-10-14）已写入正文与 PRD-beta v0.5。

---

## 2. 秒传后续

第一版已实现，版本判定、条目、命中与分叉设计已并入 [DESIGN §5.4](./DESIGN.md#54-秒传与共享结果)。

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
- 共享书（DESIGN §5.4）上改选等于「清空分析 + 换方案」的分叉：从源文件按新方案导入新书，条目立即切换
- 前端：上传 `accept` 加 `.txt`；书详情显示当前方案和「换一种分章」，弹窗里列出预览，已有分析结果时确认文案写明「会清空现有分析，已用额度不退还」

shortcut：不支持用户自定义正则与多方案组合（PRD-beta §7「不做」）；以后要做，就是在资源文件之外再读一份用户规则，接口不变。

---

## 5. 后台管理

产品规则见 PRD-beta §8。都是管理员接口，沿用 `accounts.requireAdministrator`，挂在 `/api/admin/*` 下。

### 5.1 页面

前端新增 `/admin`，按页签挂载：用量、模型、评测（现 `EvalPage` 原样搬入，`/eval` 跳转到 `/admin?tab=eval`）、账号（现 `AdminPanel` 搬入，账号弹窗里的入口改成跳转）、反馈（反馈任务时再加）。书架上的「评测」入口改为「后台」。

token 隐藏：书详情接口的 `token_usage` 只对管理员返回，前端三处显示（`HeaderBar`、`DetailPanel` 概况、`BookShelf` 卡片）没有该字段就不显示，不再按角色额外判断。

### 5.2 用量看板

只读 `usage_ledger`（DESIGN §5.6），不新建表：

- `GET /api/admin/usage/daily?days=30`：按 `zhiying.quota.time-zone` 的自然日汇总 token；今日另加运行中任务的实时 token（与额度检查同一口径）
- `GET /api/admin/usage/users`：按 `user_id` 汇总字数、token，连同书架条目数
- `GET /api/admin/usage/books`：按条目汇总 token，带书名与所有者用户名

查询按需聚合，内测数据量下不做缓存或预汇总表。

### 5.3 模型配置

新表 `model_settings`：

| 列 | 说明 |
|---|---|
| `call_point` | 主键：`READING` / `POST_PROCESS` / `AFFILIATION` |
| `model` | 模型名；空表示用 `zhiying.llm.model` |
| `thinking` | 是否开思考 |
| `updated_at`、`updated_by` | — |

- 读取顺序：表里有行用表，否则用 `zhiying.reading` / `post-process` / `affiliation` 里现有的 `model`、`thinking`。表只覆盖这两项，地址与密钥仍只来自 `zhiying.llm.*`。这是「可调参数统一放 `ZhiYingProperties`」的唯一例外，ARCHITECTURE 里写明
- 生效时机：任务启动时取一次当前配置，放进本次任务的调用上下文，整个任务用同一份；不在任务中途换模型。目前各调用点的模型在启动时装配，改为按调用传入模型名与思考开关（Spring AI 的请求级 options 支持）
- 方法版本（DESIGN §5.4）改为按当前生效配置计算，所以后台换模型后旧结果自然不能秒传
- `GET /api/admin/models` 返回三个调用点的生效值与来源（后台 / 配置文件）；`PUT /api/admin/models/{callPoint}` 修改；`DELETE` 恢复配置文件的值
- 「测试连接」复用 `/api/diagnostics/model`，加一个可选的模型名参数

shortcut：模型名不校验是否存在于服务商（没有统一的列模型接口），靠保存后点「测试连接」确认。
