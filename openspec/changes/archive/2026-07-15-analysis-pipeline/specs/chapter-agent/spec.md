## ADDED Requirements

### Requirement: Chapter Agent tool-calling loop
系统 SHALL 使用 LangChain 的 tool-calling 能力运行 Chapter Agent，循环执行「LLM 决策 → 工具调用 → 结果加入上下文」直到模型调用 `submit_result` 或达到 `max_agent_steps` 上限。`max_agent_steps` 默认 20，长章（char_count > inject_max_chars）SHALL 按窗数抬高为 `min(40, 8 + 2 * num_windows)`。

#### Scenario: 短章正常完成
- **WHEN** Chapter Agent 分析 char_count=3000 的章节，模型调用 submit_result 成功
- **THEN** Agent 循环结束，返回 ChapterLedger（含 persons、relations、events、summary）

#### Scenario: 达到步数上限
- **WHEN** Agent 在 max_agent_steps 步内未调用 submit_result
- **THEN** Agent 循环结束，返回当前已累积的部分结果（可为空 ledger），记录 warning 日志

### Requirement: 短章正文注入
当当前章 `char_count ≤ settings.inject_max_chars`（默认 10000）时，编排器 SHALL 将章正文全文注入 user prompt，Agent 无需调用 `read_chapter_window` 即可看到全部正文。

#### Scenario: 短章整章注入
- **WHEN** Chapter char_count=8000，inject_max_chars=10000
- **THEN** user prompt 包含 cast 快照 + 章节元信息 + 【全文 content】；Agent 可直接分析无需读窗

### Requirement: 长章分窗策略
当当前章 `char_count > settings.inject_max_chars` 时，编排器 SHALL 只注入章节元信息（title、char_count、建议窗数）和分窗纪律提示，不注入正文。Agent SHALL 使用 `read_chapter_window` 逐窗读取正文。建议窗数 = `ceil(char_count / read_window_chars)`。

#### Scenario: 长章不注入正文
- **WHEN** Chapter char_count=25000，inject_max_chars=10000
- **THEN** user prompt 包含 cast 快照 + 元信息 + 「本章共 25000 字符，建议分 5 窗读取」的纪律提示，不包含正文

#### Scenario: 长章步数抬高
- **WHEN** 长章 char_count=25000，read_window_chars=5000，num_windows=5
- **THEN** max_agent_steps 设为 `min(40, 8 + 2*5) = 18`

### Requirement: Chapter Agent prompt 模板
系统 SHALL 在 `agent/prompts/chapter.py` 中定义 LangChain ChatPromptTemplate。System prompt SHALL 包含：(1) 角色（章级人物关系分析）；(2) 关系类型短枚举（引用 `relation_summary_for_prompt()`）；(3) 工具使用纪律（先读文再分析、章末一次 submit_result）；(4) 出口约定（type 枚举闸门、person_id 闸门）。User prompt SHALL 包含：章节元信息 + cast 快照摘要 + （短章）全文 /（长章）分窗纪律。

#### Scenario: prompt 包含关系枚举
- **WHEN** 渲染 system prompt
- **THEN** prompt 中包含完整关系类型列表（夫妻、亲子、兄妹、表亲、师徒、主仆、上下级、同门、结盟、敌对、朋友、相识、同场），每项含 tier 和 directed 标注

### Requirement: 空 cast 可运行
当 cast 快照为空（persons=[]）时，Chapter Agent SHALL 正常运行。Agent SHALL 通过 `propose_cast_update` 提议新人物，获得临时 person_id 后在 `submit_result` 中引用。

#### Scenario: 空 cast 首章分析
- **WHEN** 书籍无 NLP Cast Pass，cast 快照为空，Chapter Agent 分析第 1 章
- **THEN** Agent 正常启动，可 propose 新人物（如 ch1_p1="贾宝玉"），submit_result 引用 ch1_p1
