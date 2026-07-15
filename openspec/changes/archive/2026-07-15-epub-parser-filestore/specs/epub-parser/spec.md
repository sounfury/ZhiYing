## ADDED Requirements

### Requirement: EPUB metadata extraction
系统 SHALL 从 EPUB 文件的 OPF 元数据中提取书名（title）和作者（author），填充到 BookMeta 中。

#### Scenario: 正常提取元数据
- **WHEN** 解析一个包含 dc:title 和 dc:creator 的标准 EPUB 文件
- **THEN** BookMeta.title 和 BookMeta.author 分别填入对应值

#### Scenario: 元数据缺失
- **WHEN** EPUB 文件没有 dc:title 或 dc:creator 元数据
- **THEN** 缺失字段填空字符串，不报错

### Requirement: Per-item layered chapter detection
系统 SHALL 对**每个 spine item 独立**执行分层降级切章，而非全书先二选一。每个 item 按以下优先级检测章节边界：(1) 内部多个 `<h1>`/`<h2>` heading → 按 heading 切；(2) 正文匹配 `第[\d一二三四五六七八九十百千]+[章回节卷]` 或 `Chapter\s+\d+` 多处 → 正则切；(3) 以上均不匹配 → 整个 item 作为一个 Chapter。切完后统一过滤短章并按序重编号 `chapter_id = order`。

#### Scenario: item 内多 heading 切分
- **WHEN** 某个 spine item 内包含 3 个 `<h1>` 标签
- **THEN** 按 heading 位置切分为 3 个 Chapter

#### Scenario: item 内正则切分
- **WHEN** 某个 spine item 内无 heading 标签，但正文包含 2 处匹配 `第[\d一二三四五六七八九十百千]+[章回节卷]` 的模式
- **THEN** 按正则匹配位置切分为 2 个 Chapter

#### Scenario: item 整体作为一章
- **WHEN** 某个 spine item 内无 heading 标签，正文也不匹配章节正则
- **THEN** 整个 item 作为一个 Chapter，title 取文件名或 "未命名"

#### Scenario: 多个 spine item 各自独立切分
- **WHEN** EPUB spine 有 3 个 item：item1 内有 2 个 heading，item2 无 heading 也无正则匹配，item3 匹配 4 处正则
- **THEN** 最终得到 2 + 1 + 4 = 7 个 Chapter，chapter_id = 1..7

### Requirement: HTML to plain text cleaning
系统 SHALL 将 EPUB 内的 XHTML 内容清洗为纯文本：去除所有 HTML 标签，将 `<p>`/`<br>`/`<div>` 转换为段落换行（`\n\n`），解码 HTML 实体。

#### Scenario: 正常清洗
- **WHEN** 输入包含 `<p>段落一</p><p>段落二</p>` 的 XHTML
- **THEN** 输出 `段落一\n\n段落二`

#### Scenario: HTML 实体解码
- **WHEN** 输入包含 `&amp;` `&lt;` `&nbsp;` 等 HTML 实体
- **THEN** 输出中实体被解码为对应字符

### Requirement: Word count for mixed Chinese-English text
系统 SHALL 计算每个章节的 word_count：去除空白和标点后，中文字符按字计，英文按空格分词计，两者之和为 word_count。

#### Scenario: 纯中文
- **WHEN** 章节内容为纯中文（如 "此开卷第一回也"）
- **THEN** word_count 等于中文字符数（去标点和空白后）

#### Scenario: 中英混合
- **WHEN** 章节内容包含中文和英文（如 "贾宝玉 said hello"）
- **THEN** word_count = 中文字符数 + 英文词数

### Requirement: Chapter title extraction
系统 SHALL 为每个章节提取标题，优先级：TOC 导航对应 > `<h1>`/`<title>` 标签 > 正则匹配的章标题 > "第N章" > "未命名"。

#### Scenario: 从 heading 提取
- **WHEN** 章节由 `<h1>` 标签切分
- **THEN** 章节标题取 `<h1>` 标签的文本内容

#### Scenario: 从正则匹配提取
- **WHEN** 章节由正则匹配切分
- **THEN** 章节标题取正则匹配到的完整文本（如 "第一章 甄士隐梦幻识通灵"）

### Requirement: Profiling computation
系统 SHALL 在解析完成后计算 BookMeta 的 profiling 字段：total_words（所有章节 word_count 之和）、max_chapter_words（最大单章字数）、median_chapter_words（中位数单章字数）。

#### Scenario: 正常计算
- **WHEN** 解析完毕，得到 N 个章节
- **THEN** total_words = sum(ch.word_count)，max_chapter_words = max(ch.word_count)，median_chapter_words = median(ch.word_count)

### Requirement: Short chapter filtering and renumbering
系统 SHALL 过滤掉 word_count 低于阈值（默认 200）的章节（如封面、版权页、目录页），不将它们计入章节列表。过滤后剩余章节按序重新编号 `chapter_id = order = 1..N`。若过滤后剩余 0 章，系统 SHALL 抛出 EPUB_PARSE_ERROR 而非静默返回 total_chapters=0。

#### Scenario: 过滤封面页
- **WHEN** 某个 spine item 清洗后 word_count = 50（低于阈值 200）
- **THEN** 该 item 不产生 Chapter，不占用 chapter_id

#### Scenario: 保留短章
- **WHEN** min_chapter_words 参数设为 0
- **THEN** 所有 spine item 均产生 Chapter，包括极短的

#### Scenario: 过滤后重编号
- **WHEN** 切章得到 5 个片段，其中第 1 个（封面）和第 3 个（插图页）word_count < 阈值
- **THEN** 剩余 3 个 Chapter 的 chapter_id = 1, 2, 3（连续重编号，不跳号）

#### Scenario: 全部被过滤——零章报错
- **WHEN** 所有切章片段的 word_count 均低于阈值（如诗集、短文集，或全为封面/目录页）
- **THEN** 抛出 AppError(EPUB_PARSE_ERROR)，message 明确指出「无有效章节：所有章节低于 {min_chapter_words} 字阈值」

### Requirement: source_href tracking
系统 SHALL 在每个 Chapter 中记录 source_href 字段，标识该章内容来源于哪个 EPUB spine item。

#### Scenario: 一文件一章
- **WHEN** 一个 spine item 直接对应一章
- **THEN** Chapter.source_href 设为该 spine item 的 href 或 id

#### Scenario: 一文件多章
- **WHEN** 一个 spine item 被切分为多章
- **THEN** 这些 Chapter 的 source_href 均设为该 spine item 的 href 或 id
