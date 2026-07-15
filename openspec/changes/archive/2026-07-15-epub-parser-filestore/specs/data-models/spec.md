## ADDED Requirements

### Requirement: BookMeta source_file field
BookMeta 模型 SHALL 包含 `source_file: str` 字段，记录原始 EPUB 文件名（不含路径），用于书目列表展示和溯源。

#### Scenario: 上传时填充
- **WHEN** 用户上传文件名为 "红楼梦.epub" 的 EPUB
- **THEN** BookMeta.source_file = "红楼梦.epub"

#### Scenario: 默认值
- **WHEN** BookMeta 对象未显式设置 source_file
- **THEN** source_file 默认为空字符串 ""

### Requirement: Chapter source_href field
Chapter 模型 SHALL 包含 `source_href: str` 字段，记录该章内容来源于 EPUB 哪个 spine item 的 href，用于调试和重解析时追踪原始结构。

#### Scenario: 一文件一章
- **WHEN** 一个 spine item（href="chapter1.xhtml"）直接对应一章
- **THEN** Chapter.source_href = "chapter1.xhtml"

#### Scenario: 一文件多章
- **WHEN** 一个 spine item（href="part1.xhtml"）被切分为 3 章
- **THEN** 这 3 个 Chapter 的 source_href 均为 "part1.xhtml"

#### Scenario: 默认值
- **WHEN** Chapter 对象未显式设置 source_href
- **THEN** source_href 默认为空字符串 ""

### Requirement: Chapter include_in_analysis field
Chapter 模型 SHALL 包含 `include_in_analysis: bool` 字段。解析器按标题启发打标；`false` 的章仍落盘并出现在章节列表，但默认不进入 AI 分析队列。吃不准时 SHALL 默认为 `true`。

#### Scenario: 导读与年表
- **WHEN** 章节标题含「导读」或「年表」等非正文启发词
- **THEN** include_in_analysis = false

#### Scenario: 正文分节
- **WHEN** 章节标题匹配「第X章/回」或「Chapter N」
- **THEN** include_in_analysis = true

#### Scenario: 默认值
- **WHEN** Chapter 对象未显式设置 include_in_analysis
- **THEN** include_in_analysis 默认为 true

### Requirement: BookMeta analysis_chapter_count
BookMeta SHALL 包含 `analysis_chapter_count: int`，等于 include_in_analysis=true 的章数。

#### Scenario: 解析后计数
- **WHEN** 解析完成且 7 章中 5 章 include_in_analysis=true
- **THEN** analysis_chapter_count = 5
