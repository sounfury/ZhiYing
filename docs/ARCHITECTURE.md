# CastAtlas 技术架构设计

| 项 | 内容 |
|----|------|
| 文档性质 | 架构设计 v0.7 |
| 日期 | 2026-07-15 |
| 依据 | [PRD v0.2](./PRD.md) |
| 状态 | 草案（实现前可改） |
| 部署假设 | **本机个人使用**；默认信任操作者，不为「防恶意入参 / 多租户」提前付工程税 |

---

## 1. 架构总览

```
┌─────────────────────────────────────────────────────────────┐
│                        浏览器（前端）                         │
│  React + TypeScript + AntV G6                                │
│                                                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐    │
│  │ 书籍上传  │  │ 分析进度  │  │ 人名册编辑│  │  图谱视图  │    │
│  │  组件    │  │  组件    │  │  组件    │  │  (主交互) │    │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘    │
│                                              │              │
│  ┌──────────────────────────────────────────┤              │
│  │  控制面板：章节滑块 / 过滤阈值 / 渲染样式  │              │
│  └──────────────────────────────────────────┘              │
└──────────────────────────┬──────────────────────────────────┘
                           │ REST + SSE
┌──────────────────────────┴──────────────────────────────────┐
│                      后端 API 层 (FastAPI)                    │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐    │
│  │ 书籍路由  │  │ 分析路由  │  │ 图谱路由  │  │ 校对路由  │    │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘    │
└───────┼─────────────┼─────────────┼─────────────┼───────────┘
        │             │             │             │
┌───────┴─────────────┴─────────────┴─────────────┴───────────┐
│                       核心服务层                              │
│                                                              │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────┐        │
│  │ EPUB Parser  │  │ Orchestrator │  │ Aggregator  │        │
│  │ (ebooklib)   │  │ (编排引擎)    │  │ (汇总出图)   │        │
│  └─────────────┘  └──────┬───────┘  └─────────────┘        │
│                          │                                   │
│              ┌───────────┴───────────┐                      │
│              │   Agent Pipeline       │                      │
│              │                        │                      │
│              │  ┌──────────────────┐  │                      │
│              │  │ NLP Cast Pass    │  │  (辅助：全书人名候选)  │
│              │  └──────────────────┘  │                      │
│              │  ┌──────────────────┐  │                      │
│              │  │ Chapter Agent    │  │  (主路径：章级分析)    │
│              │  │  + Tool Suite    │  │                      │
│              │  └──────────────────┘  │                      │
│              │  ┌──────────────────┐  │                      │
│              │  │ Reconcile Agent  │  │  (few_long 终局归纳)  │
│              │  └──────────────────┘  │                      │
│              │  ┌──────────────────┐  │                      │
│              │  │ Memory Manager   │  │  (辅助：章/大总结)    │
│              │  └──────────────────┘  │                      │
│              │  ┌──────────────────┐  │                      │
│              │  │  Cast Writer     │  │  (人名册单写队列)      │
│              │  └──────────────────┘  │                      │
│              └────────────────────────┘                      │
│                                                              │
│  ┌─────────────────────────────────────────────────┐        │
│  │                   存储层                          │        │
│  │  SQLite (元数据/状态)  +  JSON 文件 (章账本/总结)  │        │
│  └─────────────────────────────────────────────────┘        │
└──────────────────────────────────────────────────────────────┘
                           │
                    ┌──────┴──────┐
                    │ LLM Provider  │
                    │ LC ChatModel  │
                    │ OpenAI 兼容   │
                    └─────────────┘
```

**主路径 vs 辅助：**

| 层级 | 模块 | 作用 | 实现期 |
|------|------|------|--------|
| **主路径** | Chapter Agent +（few_long）Reconcile + Aggregator | 章内提取、归纳、出图；质量大头 | **一期** |
| **辅助** | NLP Cast Pass | 全书人名候选，对齐/降噪；非出图 SSOT | **二期**（长篇价值大） |
| **辅助** | Memory Manager | 章间情节上下文；波次时用 | **二期**（长篇价值大） |

**并行（一期先落地 few_long）：** 中篇/少章 → 全章并行 + 终局归纳；长篇波次 → 二期与记忆一起做。详见 §4.6、§13。

---

## 2. 技术选型

| 层 | 选型 | 理由 |
|----|------|------|
| 前端框架 | React 18 + TypeScript | 生态成熟；类型安全；组件化适合复杂图谱交互 |
| 图谱渲染 | AntV G6 v5 | 一期纯文字节点；力导向；导出 PNG；头像框二期 |
| 前端构建 | Vite | 快速 HMR；轻量配置 |
| UI 组件 | Ant Design | 滑块、抽屉、表单等现成组件；与 G6 同生态 |
| 后端框架 | FastAPI (Python) | 异步原生支持 SSE；自动 OpenAPI 文档；Python 生态适合 LLM 编排 |
| EPUB 解析 | ebooklib + BeautifulSoup4 | Python 生态成熟的 EPUB 解析方案 |
| LLM 协议 | OpenAI 兼容 Chat Completions + tool calling | 各厂商换 `base_url` / key / model；默认厂商一期实现时定 |
| Agent 运行时 | **LangChain**（最小依赖，见 §2.1） | 工具注解注册、tool-calling loop、**提示词模板**、ChatModel 适配 |
| 中文 NLP（Cast） | HanLP / 同类 NER（二期） | 全书人名扫描：本地、快、廉价；只出候选通讯录 |
| 数据库 | SQLite | 本地优先；零部署；单文件便携；足够支撑单书数据量 |
| 文件存储 | JSON 文件（按章落盘） | 章 JSON 是「事实账本」；文件可读、可 diff、可手动修复 |
| 进度推送 | SSE (Server-Sent Events) | 单向推送足够；比 WebSocket 简单；FastAPI 原生支持 |

### 2.1 LangChain 作用域（已定）

**用 LangChain 做「单章 / 终局 Agent 运行时」，不用它做书级编排。**

| 用 LC | 不用 LC |
|--------|---------|
| `@tool`（或等价）注解注册工具，与业务实现解耦 | **Orchestrator**（双模式、波次、few_long 并行、frontier、SSE 进度） |
| Agent tool-calling 循环（步数上限、消息拼装） | **Memory Manager** 的 SSOT 与压缩策略（二期；LC Memory 组件不用） |
| **ChatPromptTemplate 等提示词模板**（system/user 骨架 + 变量注入） | **Cast Writer** 单写队列与 merge |
| `ChatOpenAI`（或等价）+ 可配置 `base_url` / `api_key` / `model` | **Aggregator** 出图、override、图算法 |

**依赖收敛（建议）：** `langchain-core` + `langchain-openai`（或当前等价最小集）；避免一上来拉满 community 全家桶。  
**可选：** 需要更广的非兼容厂商路由时再评估 LiteLLM，与 LC ChatModel 并存或替换传输层——非一期必选。

**提示词约定：**

- 模板管骨架：角色、关系枚举、工具纪律、出口约定  
- 变量由编排器/服务层算好后注入：`chapter_id`、cast 摘要/版本、模式（few_long 不注入记忆；many_chapters 注入 MemorySnapshot）、Reconcile 冲突表等  
- **正文进入方式（注入优先 + 限量续读）**——见 §4.3.1；**不是**「默认空 prompt，必须先 `get` 整章」  
- 出口仍由业务校验卡死：`submit_result` 非法 type / person_id → **tool 返回错误字符串** 让模型改，不依赖 LC 隐式重试策略绕过闸门  

**调用关系：**

```text
Orchestrator（自研）
    → 仅调度 include_in_analysis=true 的章（§3.2）
    → chapter_agent / reconcile_agent（LangChain：prompt + tools + loop）
        → ChatModel（OpenAI 兼容）
        → 工具实现（读 workspace / CastWriter 缓冲 / Pydantic 校验）
```

### 2.2 横切基础（按期，别超前）

**前提：** 本机个人项目。P0 只放「不做会直接拖累主路径」的薄约定；  
path jail、全局 catalog、正式 jobs 框架等对当前收益为负，**一律 P2（三期）**。

#### 2.2.1 P0 就要的（薄）

| 能力 | 落点（拟定） | 怎么做就够 |
|------|----------------|------------|
| **配置** | `app/config.py` | LLM `base_url` / key / model、`WORKSPACE_ROOT`、并行章数；`.env` gitignore |
| **关系枚举 SSOT** | `app/domain/relation_types.py` | §4.5 唯一权威源；prompt / `submit_result` / Aggregator **同一份**；可另挂 `GET /api/meta/relation-types` 给前端（也可先前后端各引同一份生成，但禁止两套手写中文表） |
| **错误形态** | `app/errors.py` 或 `app/errors/*` | 一个 `AppError` + FastAPI 全局 handler 即可；错误体带 `code` + `message` 方便前端 toast |
| **日志** | 标准 `logging` | print 级可跑通；统一 format 即可，**不要** request_id 中间件 |
| **书目列表** | `storage` 扫 `workspace/*` 读 `meta.json` | 个人书量级足够 |
| **分析中别重入** | Orchestrator / 路由里几行 | `if book.status == analyzing: 拒绝`；**不必**单独 `jobs.py` |
| **取消分析** | 协作标志 or 先不做精致 stop | P0 有 stop 更好；实现可以很糙（设 flag，循环里看一眼） |
| **路径** | `workspace / book_id / ...` 普通拼接 | book_id 用 uuid 自己生成即可；**不做** jail 套件 |
| **LLM 并行** | 配置 `max_parallel_chapters` | asyncio 信号量写在编排里一行，**不必** `rate_limit.py` 模块 |
| **CORS** | `main.py` 开发放行 | 本机 Vite 需要 |

**P0 错误码（够用就停，别先做大表）：**  
`BOOK_NOT_FOUND` · `EPUB_PARSE_ERROR` · `ANALYSIS_ALREADY_RUNNING` · `INVALID_RELATION_TYPE` · `LLM_PROVIDER_ERROR` · `VALIDATION_ERROR` · `INTERNAL_ERROR`  
用到再加。

**Agent 工具校验失败：** 仍不走 HTTP → 错误字符串回给模型（与是否正式错误码模块无关）。

#### 2.2.2 P1 仍不必上的

与现有分期一致：NLP Cast Pass、Memory + many_chapters 波次、头像框等——见 §13，**不是**本节 hardening。

#### 2.2.3 P2（三期）才考虑的硬化 / 工程化

本地自己用、主路径稳定之后，若真痛再做：

| 能力 | 说明 | 为何不是 P0 |
|------|------|-------------|
| **Workspace path jail** | 防 `book_id=../` 穿出目录 | 本机信任操作者；uuid 已够用 |
| **全局书目索引** catalog.db / index.json | 列表不扫盘 | 个人书少，扫 `meta.json` 更简单 |
| **jobs.py 任务框架** | 正式互斥、队列、取消状态机 | 几行 status 判断即可；框架是负收益 |
| request_id 中间件 / 结构化日志字段全集 | 联调排障 | 单人本机看终端日志够 |
| 独立 `rate_limit` 模块、health 探活、schema 迁移框架 | 运维向 | 无多实例、无发布管道 |
| 鉴权、多用户、Celery、OpenTelemetry… | 产品形态变了再谈 | 明确不做直到需要 |

#### 2.2.4 分层（P0 心智图）

```text
main.py
  ├── exception handler（薄）
  ├── api/*  → core/* / storage/* / domain/relation_types
  ├── agent/*（LC）→ domain + storage + config
  └── config
```

---

## 3. 数据模型

### 3.1 存储分层

```
/workspace/{book_id}/
├── meta.json              # 书籍元数据
├── chapters/
│   ├── chapter_001.json   # 章节正文 + 元信息
│   ├── chapter_002.json
│   └── ...
├── cast.json              # 人名册（可编辑）
├── ledger/
│   ├── chapter_001.json   # 章级分析结果（账本）
│   ├── chapter_002.json
│   └── ...
├── memory/
│   ├── summaries.json     # 各章短总结
│   ├── grand_summary.json # 大总结（若触发压缩）
│   └── frontier.json      # 连续完成前缀 + cast_version
├── overrides/             # 人工修正（关系等）；不直接改 ledger
├── merge_queue.json       # 待合并队列
└── castatlas.db           # SQLite（索引 & 状态；SSOT 分析进度）
```

### 3.2 核心数据结构

#### Book / Meta

```json
{
  "book_id": "uuid",
  "title": "红楼梦",
  "author": "曹雪芹",
  "total_chapters": 120,
  "status": "analyzed",        // uploaded | cast_pass | analyzing | analyzed
  "created_at": "2026-07-14T...",
  "analysis_progress": {
    "cast_pass_done": true,
    "chapters_done": [1, 2, 3, ..., 80],
    "chapters_pending": [81, ..., 120]
  }
}
```

#### Chapter

```json
{
  "chapter_id": 1,
  "title": "第一回 甄士隐梦幻识通灵",
  "order": 1,
  "content": "此开卷第一回也...",
  "word_count": 5200,
  "source_href": "Text/chapter001.xhtml",
  "include_in_analysis": true
}
```

**`include_in_analysis`（是否进 AI 分析）：**

| 值 | 含义 |
|----|------|
| `true` | 默认进分析队列（Chapter Agent / Cast Pass 正文扫描） |
| `false` | 仍落盘、仍出现在章节列表，但**默认不跑 AI**（导读、序言、年表、附录、版权页等） |

- 解析 EPUB 后由程序打标（标题关键词 + 可选位置启发），**不用主 Agent 选章**  
- 吃不准时默认 `true`（宁肯多分析，别漏正文）  
- 后续 UI 可勾选覆盖；`POST /analyze` 只调度 `include_in_analysis=true` 的章（或用户显式勾选集）  
- `word_count` / profiling 仍统计**全部已切章**；模式判定可用「分析章」子集再算一版（实现时二选一写清即可）

**自动标 `false` 的标题启发（初值，可配）：**  
导读、序言、前言、译序、目录、版权、出版说明、年表、大事记、附录、注释、参考文献、作者简介、后记、跋、preface、foreword、contents、chronology、appendix、copyright…  
**强 `true` 信号：** 标题匹配 `第X章/回/节`、`Chapter N` 等正文分节模式。

#### Cast（人名册）

```json
{
  "persons": [
    {
      "person_id": "p001",
      "canonical_name": "贾宝玉",
      "aliases": [
        { "name": "宝玉", "frequency": "high" },
        { "name": "宝二爷", "frequency": "mid" },
        { "name": "绛洞花主", "frequency": "low" }
      ],
      "bio": "贾府嫡孙，衔玉而生",
      "gender": "male",
      "importance": "main",       // main | supporting | minor
      "merge_candidates": []      // 疑似同人的 person_id 列表
    }
  ]
}
```

#### Chapter Ledger（章账本 — 事实数据源）

约定：

- `chapter_id` 为 **int**（与 `order` 一致）；落盘文件名 `chapter_{id:03d}.json` 仅为存储细节
- 关系端点字段：
  - **无向**（`directed=false`）：`person_a` / `person_b` 按 `person_id` 字典序排序后写入（`a < b`）
  - **有向**（`directed=true`）：`person_a` = from，`person_b` = to（如亲子：父母→子女；师徒：师傅→徒弟）
- 汇总键：无向 `(min_id, max_id, type)`；有向 `(from_id, to_id, type)`
- `type` 必须属于系统短枚举（§4.5），否则 `submit_result` 拒绝

```json
{
  "chapter_id": 3,
  "persons": [
    { "person_id": "p001", "aliases_in_chapter": ["宝玉", "宝二爷"] },
    { "person_id": "p005", "aliases_in_chapter": ["林妹妹"] }
  ],
  "relations": [
    {
      "person_a": "p001",
      "person_b": "p005",
      "type": "表亲",
      "tier": "hard",
      "directed": false,
      "evidence": {
        "chapter_id": 3,
        "quote": "宝玉走近黛玉身边...",
        "note": "本章明确二人表亲关系",
        "quote_verified": null
      }
    }
  ],
  "events": [
    { "description": "宝黛初会", "persons": ["p001", "p005"] }
  ]
}
```

#### Aggregated Edge（汇总后的边 — 前端消费）

```json
{
  "person_a": "p001",
  "person_b": "p005",
  "tags": [
    {
      "type": "表亲",
      "tier": "hard",
      "directed": false,
      "chapter_ids": [3, 5, 7, 12],
      "evidences": [
        { "chapter_id": 3, "quote": "宝玉走近黛玉身边..." },
        { "chapter_id": 7, "quote": "黛玉见宝玉..." }
      ],
      "display_score": 8.5
    },
    {
      "type": "朋友",
      "tier": "soft",
      "directed": false,
      "chapter_ids": [3, 5, 7],
      "evidences": [],
      "display_score": 2.1,
      "suppressed": true
    }
  ]
}
```
---

## 4. 后端模块设计

### 4.1 EPUB Parser（解析器）

**职责：** EPUB → Book + Chapter[]（含 `include_in_analysis` 打标）

```
输入: .epub 文件
输出: BookMeta + Chapter[]（落盘由 Filestore / API 完成）

流程:
  1. 用 ebooklib 读取 EPUB spine，按阅读顺序提取
  2. BeautifulSoup4 清洗 HTML → 纯文本
  3. per-spine-item 分层切章（heading → 正则 → 整 item）
  4. 短章过滤、重编号 chapter_id = order
  5. 为每章设置 include_in_analysis（标题启发，§3.2）
  6. profiling：total/max/median word_count
```

### 4.2 Orchestrator（编排引擎）

**职责：** 控制「两遍 + 汇总」的主流程，管理状态、波次并行与中断恢复。

```
状态机（一期可跳过 cast_pass）:

  uploaded ──▶ [可选] cast_pass_running ──▶ cast_pass_done
                        │                         │
                        └───────────┬─────────────┘
                                    ▼
                            chapter_analyzing
                             (双模式调度, 可中断)
                                    │
                     ┌──────────────┴──────────────┐
                     ▼                             ▼
               (few_long)                    (many_chapters)
          reconcile_running                  （波次；需记忆，二期）
                     │                             │
                     └──────────────┬──────────────┘
                                    ▼
                                analyzed

  * 任意阶段可中断 → 重启后从 SQLite 恢复断点
  * 单章可重跑 → 覆盖该章 ledger
```

高层策略：

- **主路径：** Chapter Agent 提取 +（few_long）Reconcile 归纳 + Aggregator 出图
- **Cast Pass / Memory：** 辅助层，与「必须先有才分析」解耦；无 Cast 时章分析仍可 `propose` 新人
- Chapter Analysis：**双模式**（§4.6）；**一期先实现 few_long**
- 人名册写入：一律经 **Cast Writer** 串行合并

### 4.3 Agent / NLP 管线

#### NLP Cast Pass（第 0 遍 · 辅助 · 二期实现）

**定位：** 与章间记忆同类——**辅助对齐人名，不是事实账本，也不阻塞出图主路径**。  
书越长、人物越多，全局扫一遍的价值越大；中短篇仅靠章内提取 + 归纳通常够用。

```
目标: 全书（或已导入正文）快速扫一遍，生成人名册草稿

输入:
  - chapters/*.json 正文（或拼接流式扫描）

流水线（传统 NLP，不跑 LLM）:
  1. 中文分词 + NER（如 HanLP 感知机/CRF，标 nr/nrf 等）
  2. 人名频次统计；低频过滤（可配阈值）
  3. 粗别名启发（可选）：三字名 ↔ 名字部分等简单规则
  4. 写入 cast.json 草稿（canonical≈高频形式，aliases 可空或规则填）
  5. 可选：行/窗共现矩阵仅作调试，不直接当关系账本

输出:
  - cast.json（粗糙通讯录 + 可选 frequency 字段）
  - 不产生 ledger 关系边

约束:
  - 允许漏人、裂人、误识别；后续章分析 / Reconcile / 人工编辑修正
  - 速度目标：长篇分钟级内完成为佳（本地 CPU）
  - 一期：整步可跳过；分析中从空 cast 起步即可
```

不做：联网百科主路径、全书 LLM Cast Pass（贵且与章分析重复）。

#### Chapter Agent（章级分析）

**实现：** LangChain 运行时（§2.1）——工具 `@tool` 注册、ChatPromptTemplate、tool-calling loop。  
**入口：** 由 Orchestrator 调用；不在 LC 内做章间调度。  
**范围：** 仅 `include_in_analysis=true` 的章（导读/年表等默认不进）。

```
目标: 分析单章，产出章 JSON + 章总结

输入:
  - chapter_id（已由编排器选中，必为分析章）
  - 人名册（当前版本 / 模式决定是否冻结）
  - 前文记忆：仅 many_chapters 注入 MemorySnapshot；few_long 不注入章间记忆
  - 正文：短章整章注入 / 长章仅元数据 + 分窗工具（§4.3.1）

提示词（LangChain 模板，见 agent/prompts/）:
  - system：角色、关系短枚举、工具用法、步数/出口纪律
  - user：章元信息 + cast 摘要/版本 +（可选）MemorySnapshot
         + 短章时附【全文】；长章时附 char_count / 建议窗数 / 从 offset=0 读起的纪律
  - few_long vs many_chapters：可用不同模板或同一模板 optional 块

工具集（注解注册，实现与 schema 解耦）:
  ┌──────────────────────┬────────────────────────────────────────┐
  │ 工具                  │ 说明                                    │
  ├──────────────────────┼────────────────────────────────────────┤
  │ read_chapter_window  │ 限量续读本章正文（offset/index + limit） │
  │ grep_in_chapter      │ 章内搜索人名/关键词，返回命中行           │
  │ query_cast           │ 查人名册（只读快照）                      │
  │ propose_cast_update  │ 提议新人/新别名（缓冲，经 CastWriter）    │
  │ submit_result        │ 提交本章 JSON（校验后入波次缓冲）         │
  └──────────────────────┴────────────────────────────────────────┘

说明:
  - **不再**提供无界的 `get_chapter_text(整章)` 作为默认工具
  - 当前章分析：编排已知 chapter_id，短章直接注入，无需为「读本章」烧 1 步
  - Reconcile 回查他章：可复用 `read_chapter_window(chapter_id=…)` 或只读 grep
  - 「读一点写一点」：窗内在对话中累积关系草稿（或轻量 append_draft，P1）；
    **章末一次** `submit_result`（避免每窗正式提交导致章内 merge 复杂度）

约束（出口紧）:
  - 关系 type 必须在短枚举内，否则 submit_result 拒绝（tool 错误回传，非静默吞掉）
  - 每条关系必须带 chapter_id + note（quote 鼓励但不强制）
  - person_a / person_b 必须是 cast 中已有的 person_id（本波 propose 的新人须先成功进入缓冲 id）
  - 单章工具调用步数上限：默认 20；长章可按窗数抬高（见 §4.3.1）
  - 记忆仅使用编排器注入的 MemorySnapshot，Agent 不可自行「拉取更新后的总结」

Agent 循环（由 LangChain 承载，语义如下）:
  while not done and steps < max_steps:
    1. LLM 决策下一步动作（或提交结果）
    2. 执行工具调用
    3. 将结果加入对话上下文
    4. steps++
```

##### 4.3.1 正文注入与阅读窗（已定）

**目标：** 控制单次进入注意力的正文量；避免「默认 tool-only 整章 get」白烧步数，也避免巨章一次 dump 稀释注意力。

| 参数 | 默认 | 含义 |
|------|------|------|
| `inject_max_chars` | **10_000** | 正文 `char_count`（清洗后字符数，与截断同一套计数）≤ 此值 → **整章注入** user prompt |
| `read_window_chars` | **5_000** | 超阈值时，每次 `read_chapter_window` 最多返回的字符数 |
| `read_overlap_chars` | **300** | 相邻窗重叠，减少跨窗漏关系 |
| `max_agent_steps` | 20 起 | 短章够用；超阈值时建议 `min(40, 8 + 2 * num_windows)` 或等价抬高 |

**计数约定：** 注入/截断/阈值统一用清洗后正文的 **字符长度**（`len(content)` 或等价）；勿与展示用 `word_count`（中英混合计法）混用。可在 Chapter 上并存 `word_count`（展示/profiling）与运行时 `char_count = len(content)`。

**编排分支：**

```text
if not chapter.include_in_analysis:
    skip  # 不启动 Agent

char_count = len(chapter.content)

if char_count <= inject_max_chars:
    user = 元信息 + cast + memory? + 【全文 content】
    读文工具：可选（一般不需要）；grep / cast / submit 仍可用
else:
    user = 元信息 + cast + memory? + 【无正文】
          + char_count、建议窗数、纪律：
            「每次 read_chapter_window；读完本窗先落关系草稿；最后一次 submit_result」
    工具：read_chapter_window（强制 limit ≤ read_window_chars）+ grep + cast + submit
```

**`read_chapter_window` 返回形态（固定，模型不猜游标）：**

```text
chapter_id, segment_index, offset, limit, total_chars, has_more, text
```

**不做：**

- LLM 主 Agent 决定「哪些章注入 / 派哪些子 Agent」（选章与阈值均为程序）  
- 每窗一次正式 `submit_result`（章内 merge 过重）  
- 为过滤导读再上多层 multi-agent 树

#### Reconcile Agent（few_long 终局 · 同运行时）

与 Chapter Agent 相同栈：LC 提示词模板 + 工具（或结构化一轮输出）+ OpenAI 兼容 ChatModel。  
模板变量侧重：确定性预合并结果、冲突/候选人名表、各章 ledger 摘要；**不**用 LC 替换预合并程序逻辑。

#### Memory Manager（记忆管理器）

```
职责: 管理章总结链，在波次 barrier 时提交与压缩

关键概念 — MemorySnapshot(frontier):
  在「连续已完成前缀」frontier 处冻结的只读上下文包：
    - grand_summary（若存在）
    - summaries[max(1, frontier-r+1) .. frontier]   // 最近 r 章，r 默认 5
    - cast 只读快照（含 version）
  同一波内所有章 Agent 共用同一份 snapshot，不读波内其他章的产出。

  压缩触发（在波次提交后）:
    if total_summary_chars > threshold_chars:
      压缩较早总结 → 更新 grand_summary
      保留最近 r 章细总结
      threshold_chars 默认 8000（可配置）

存储:
  memory/summaries.json     → { "1": "第一回总结...", "2": "..." }
  memory/grand_summary.json → "前 40 回大意：..."
  memory/frontier.json      → { "frontier": 40, "cast_version": 12 }
```

> 记忆是 **工作上下文**，不是事实账本。账本仍以各章 `ledger/*.json` 为准；记忆滞后最多 `wave_size-1` 章是刻意权衡，见 §4.6。
### 4.4 Aggregator（汇总出图）

**职责：** 接收章节范围 + 过滤参数，合并账本（再 apply overrides），输出图数据。

```
输入:
  - book_id
  - chapter_range: [1, N]          // 防剧透切片
  - filter_threshold: int           // 人物出现章数下限，默认 2
  - relation_type_filter: []        // 可选：只看某些类型
  - include_suppressed: bool        // 是否显示被压制的软关系

流程:
  1. 读取 ledger（1..N）→ apply overrides/relation_overrides.json
  2. 统计每个 person 的 chapter_appearance_count（前 N 章 persons 列表出现章数）
  3. 过滤路人：appearance_count < threshold 且无 hard 关系 → 隐藏
     （聚焦模式下中心人物强制保留，由前端再滤或后端 focus_person 参数预留）
  4. 按规范键合并边，累加 chapter_ids 与 evidences
  5. 算 display_score:
       score = tier_base(hard=5, mid=3, soft=1)
             + len(chapter_ids) × 0.5
             + (has_valid_quote ? 1 : 0)
  6. 软硬压制：同一对人物存在 hard 时，soft → suppressed=true
  7. 输出 nodes[] + edges[]

输出: GraphData JSON
  {
    nodes: [{ person_id, name, gender, importance, appearance_count, ... }],
    edges: [{ person_a, person_b, tags: [...], ... }]
  }
```

**性能（滑块实时重算）：**

- MVP：全量扫 1..N 的 ledger 可接受（单书百章级 JSON）
- 预留：进程内 LRU 缓存 key=`(book_id, to_chapter, min_appearance, type_filter, include_suppressed, overrides_version)`
- 预留：按章增量前缀合并结构（prefix aggregate），拖滑块时 O(Δ) 而非 O(N)
- ledger / overrides 写入时失效相关缓存

### 4.5 关系类型枚举（系统定死）

**代码 SSOT：** `app/domain/relation_types.py`（P0 约定见 §2.2.1）。  
本节是语义规格；实现只维护这一份映射，prompt / 校验（及可选 meta API）全部引用它。

不做 GEN 式厚映射：模型必须直接输出下列 `type`；未知类型 `submit_result` 失败并提示合法列表（错误信息可带 `INVALID_RELATION_TYPE` 语义；HTTP 路径返回同 code）。

```python
# app/domain/relation_types.py — 唯一权威源（示意）
RELATION_TYPES = {
    # hard — 互不覆盖；展示优先
    "夫妻":   {"tier": "hard", "directed": False},
    "亲子":   {"tier": "hard", "directed": True},    # a→b：a 是 b 的父母
    "兄妹":   {"tier": "hard", "directed": False},   # 含兄弟姐妹
    "表亲":   {"tier": "hard", "directed": False},   # 表/堂等旁系亲缘
    "师徒":   {"tier": "hard", "directed": True},    # a→b：a 是师傅
    # mid
    "主仆":   {"tier": "mid",  "directed": True},    # a→b：a 是主人
    "上下级": {"tier": "mid",  "directed": True},    # a→b：a 是上级
    "同门":   {"tier": "mid",  "directed": False},
    "结盟":   {"tier": "mid",  "directed": False},
    "敌对":   {"tier": "mid",  "directed": False},
    # soft — 易泛滥；有 hard 时默认折叠
    "朋友":   {"tier": "soft", "directed": False},
    "相识":   {"tier": "soft", "directed": False},
    "同场":   {"tier": "soft", "directed": False},
}
```

`submit_result` / override 额外规则：

- `directed` 以枚举定义为准，模型不得自相矛盾
- 无向边入库前规范化 `person_a < person_b`（字典序）
- 有向边禁止写成反向重复条（同一 `(from,to,type)` 合并证据；若模型写出反方向，视为不同类型语义错误时拒绝或入待校对）
- MVP：`quote` 鼓励；若提供 quote，**可选** `grep_in_chapter` 软校验 → 写 `quote_verified: true|false`（V1 可升级为强约束）

### 4.6 并行与记忆：双模式调度

解析 EPUB 后做轻量 **profiling**（`total_chapters`、每章 `word_count`、总字数），选择调度画像。阈值可配置，初值示意：

```text
if total_chapters <= K_few（默认 8）
   and (max_words >= W_huge 或 median_words >= W_large):
    mode = few_long      # 章少、单章量大
else:
    mode = many_chapters # 章多（或章少但章短 → 也可走波次/近似串行，成本本就低）
```

| 模式 | 适用 | 章分析 | 章间记忆 | 收尾 |
|------|------|--------|----------|------|
| **many_chapters** | 红楼式：章多、单章相对可控 | **波次并行** | 有（MemorySnapshot） | 波次提交即可出图 |
| **few_long** | 中篇少部、每部巨量 | **目标范围内全章并行** | **无** | **确定性预合并 + 终局 Check/Merge Agent** |

章间记忆是辅助上下文，不是账本；出图始终以 ledger + override 为准。

---

#### 4.6.1 模式 A：`many_chapters` — 波次并行

**动机：** 纯串行过慢；无记忆全开全书并行则长程指代/cast 更易漂。折中为波次。

```
frontier          最大连续已完成章序：1..frontier 全部 status=done
wave_size (W)     每波并行章数，默认 5（可配置；再受 rate limit 限制）
MemorySnapshot(F) 在 frontier=F 时冻结的记忆包（§4.3）
Cast Writer       全局单写者
```

```
frontier = 0
# 可选：NLP cast_pass()；无则空 cast
snapshot = MemorySnapshot(0)  # cast +（二期）总结

while frontier < target_N:
  wave = [frontier+1 .. min(frontier+W, target_N)]

  parallel for cid in wave:          # 共享同一 snapshot（只读）
    run ChapterAgent(
      chapter_id=cid,
      memory=snapshot,               # 不含波内其他章总结
      cast_view=snapshot.cast,
    )
    # 缓冲：ledger / summary / cast_ops —— 不直接写 cast.json

  barrier
  for cid in wave (按章序):
    if success:
      落盘 ledger；CastWriter.apply(cast_ops)；append summary
    else:
      status=failed
  frontier = 最大连续 done 前缀
  必要时压缩 grand_summary
  snapshot = MemorySnapshot(frontier)
  SSE progress
```

示意（W=4）：

```
波1: 并行 [1–4]   memory=@0  → barrier → frontier=4
波2: 并行 [5–8]   memory=@4  → barrier → frontier=8
波3: 并行 [9–12]  memory=@8
```

**记忆滞后：** 波内最末章相对理想串行最多滞后 W−1 章细总结；硬关系多靠本章证据，通常可接受。  
**禁止**波内章读取未提交的 ledger/summary。

失败 / 中断：

| 场景 | 行为 |
|------|------|
| 波内单章 failed | 可单独 rerun；frontier 不越过连续 done 前缀 |
| 崩溃 | `running`→failed；从 frontier 后重新组波 |
| 单章 rerun | 覆盖该章 ledger+summary；默认不级联后续 |
| 人名合并 | 确定性 rewrite person_id（§8），不默认重跑 LLM |

---

#### 4.6.2 模式 B：`few_long` — 全章并行 + 终局检查

**动机：** 章间交接次数少，章间记忆边际收益低；吞吐应吃满并行。一致性放到 **全局可见之后** 的一轮质检，而不是跑中塞总结。

```
# Cast Pass 可选：有则读 cast.json，无则空通讯录起步
cast_snapshot = 冻结的只读 cast（开跑时 version；可为空）

# Map：目标范围内全章并行，无章间记忆
parallel for cid in 1..target_N:
  run ChapterAgent(
    chapter_id=cid,
    memory=None,                 # 或仅空总结 + cast
    cast_view=cast_snapshot,
  )
  → ledger_i, summary_i, cast_ops_i

# Reduce 1：确定性预合并（程序，不调用大模型）
  CastWriter 顺序 apply 全部 cast_ops（冲突 → merge_queue）
  按规范键合并边与证据
  生成 suspects[]：
    - 同名/别名高度重叠的异 person_id
    - 同 pair 冲突 type / 有向边反向
    - hard 边缺 quote 等（规则可配）

# Reduce 2：Check/Merge Agent（单独一轮）
  输入：
    - 各章 summary_i
    - 预合并后的 cast + 关系草稿
    - suspects[]（主啃对象）
    - 工具：查某章 ledger、grep 原文、query_cast
  输出（结构化 patch，可审计）：
    - person merge 建议 / 别名并入
    - 关系 add/remove/修正（优先带 chapter_id + quote）
    - 无法自动处理的 → 留 merge_queue / 人工校对
  禁止：无证据大面积重写账本；禁止把多章全文塞进上下文

# 应用 patch → 失效 Aggregator 缓存 → 可出图
```

进度阶段需区分，避免用户误以为「章跑完 = 可看终稿」：

```text
chapter_analyzing  →  (全部章 done)  →  reconcile_running  →  analyzed
```

**终局 Agent 分工：**

| 适合 | 不适合 |
|------|--------|
| 同人合并建议、矛盾仲裁、总结有而 ledger 无的补漏触发 | 无 quote 发明关系网 |
| 主/配粗标、待人工清单 | 抛开各章 JSON「重新合理编一版图」 |
| 工具回查原文 | 一次吞下全部巨型 ledger 正文 |

原则：**程序合并确定部分；Agent 只处理冲突与候选。**

章少但章短（未过字数阈值）时：仍可全并行；终局 Agent 可降级为「仅确定性合并、跳过 LLM 质检」。

---

#### 4.6.3 Cast Writer（两模式共用）

```
Worker：只读 cast 快照 → 产出 cast_ops；禁止直接写 cast.json
CastWriter：单协程顺序 apply；冲突进 merge_queue；bump cast_version
```

- `many_chapters`：每波 barrier 后 apply  
- `few_long`：Map 全部结束后统一 apply，再进预合并 / 终局 Agent  

---

#### 4.6.4 Chapter Agent 输入约束（按模式）

| | many_chapters | few_long |
|--|---------------|----------|
| 分析集 | 仅 `include_in_analysis=true` | 同左 |
| memory | MemorySnapshot(frontier) | 无章间记忆 |
| cast | 当前波快照（波间可更新） | 开跑时冻结快照 |
| 正文 | §4.3.1 注入 / 分窗 | 同左（巨章更常走分窗） |
| 工具 | read_window / grep / query_cast / propose_cast_update / submit_result | 同左 |
| 提交 | 波次 barrier 落盘 | 章完成入缓冲，全局 Reduce 时落盘 |

`update_cast` 语义在实现层一律为 **propose**。

---

#### 4.6.5 可选变体（非双模式默认）

| 变体 | 说明 |
|------|------|
| serial（W=1） | 质量基线 / 复现 |
| pipeline | 章 k 在 k−d done 后启动；调度更复杂 |
| 长篇可选终局轻量质检 | 不阻塞主路径；与 few_long 的强制 reconcile 不同 |
| 人工覆盖 include_in_analysis | UI 勾选强制纳入/排除某章（译序里真有关系等） |

---

## 5. API 设计

错误体见 **§2.2.1**（薄 `code` + `message`）。下列以 **P0 资源** 为主。

### 5.1 REST 端点

| 方法 | 路径 | 期 | 说明 |
|------|------|----|------|
| POST | `/api/books/upload` | P0 | 上传 EPUB，返回 book_id |
| GET | `/api/books` | P0 | 书籍列表（**扫 workspace 目录**即可） |
| GET | `/api/books/{id}` | P0 | 书籍详情 + 分析状态 |
| GET | `/api/books/{id}/chapters` | P0 | 章节列表（id / title / order，不含正文） |
| POST | `/api/books/{id}/analyze` | P0 | 启动分析（可 `to_chapter=N`）；已在分析则简单拒绝 |
| GET | `/api/books/{id}/progress` | P0 | SSE 进度推送 |
| POST | `/api/books/{id}/analyze/stop` | P0 | 中断（实现可糙） |
| POST | `/api/books/{id}/chapters/{cid}/rerun` | P0 | 重跑单章 |
| GET | `/api/books/{id}/cast` | P0 | 获取人名册 |
| PUT | `/api/books/{id}/cast` | P0 | 编辑人名册 |
| GET | `/api/books/{id}/graph` | P0 | 汇总图数据 |
| PUT | `/api/books/{id}/relations` | P0 | 人工改关系（override；type 走 SSOT） |
| POST | `/api/books/{id}/cast/merge` | P0 | 合并两人 + rewrite ledger person_id |
| GET | `/api/books/{id}/export` | P0 | 导出 JSON 等；PNG 前端画布 |
| GET | `/api/books/{id}/chapters/{cid}/result` | P0 | 单章账本 |
| GET | `/api/meta/relation-types` | P0 可选 | 枚举投影；也可先写死前端再后续对齐 SSOT |
| GET | `/api/health` | **P2** | 健康检查；本机非必须 |

### 5.2 核心查询：GET /api/books/{id}/graph

```
Query Parameters:
  to_chapter=80          // 防剧透：只汇总前 80 章
  min_appearance=2       // 人物过滤阈值
  type_filter=夫妻,师徒  // 可选：只看特定关系类型
  include_suppressed=0   // 是否含被压制的软关系

Response 200:
{
  "book_id": "xxx",
  "chapter_range": [1, 80],
  "total_chapters": 120,
  "nodes": [
    {
      "person_id": "p001",
      "name": "贾宝玉",
      "aliases": ["宝玉", "宝二爷", ...],
      "gender": "male",
      "importance": "main",
      "appearance_count": 75,
      "bio": "贾府嫡孙"
    },
    ...
  ],
  "edges": [
    {
      "person_a": "p001",
      "person_b": "p005",
      "tags": [
        {
          "type": "表亲",
          "tier": "hard",
          "chapter_ids": [3, 5, 7, 12],
          "evidences": [...],
          "display_score": 8.5,
          "suppressed": false
        }
      ]
    },
    ...
  ],
  "filtered_count": 87,      // 被过滤的路人数
  "filtered_persons": [...]   // 被过滤的人物 id+name（供前端展开查看）
}
```

### 5.3 SSE 进度推送：GET /api/books/{id}/progress

```
event: progress
data: {"phase": "chapter_analyzing", "mode": "many_chapters", "chapter_id": 42, "wave": 9, "frontier": 40, "total": 120, "done": 41}

event: progress
data: {"phase": "wave_committed", "frontier": 45, "total": 120, "done": 45}

event: progress
data: {"phase": "reconcile_running", "mode": "few_long"}   // 仅 few_long

event: done
data: {"phase": "analyzed", "mode": "few_long", "chapters_done": 5}
```

---

## 6. 前端架构

### 6.1 组件树

```
<App>
├── <BookListPage>                    // 书籍列表
│     └── <BookUploader />            // EPUB 上传
│
└── <BookDetailPage>                  // 单本书的主工作台
      ├── <HeaderBar>                 // 书名 + 分析状态 + 操作按钮
      │
      ├── <AnalysisProgress>          // 分析进度条（SSE 驱动）
      │     └── 章节进度网格（palette：done/pending/running）
      │
      ├── <GraphView>                 // ★ 核心图谱视图
      │     ├── <GraphCanvas>         // G6 画布
      │     ├── <ChapterSlider />     // 章节范围滑块（5.7.1）
      │     ├── <RenderModeToggle />  // 纯文字 / 头像框切换（5.7.2/5.7.3）
      │     ├── <FilterControl />     // 人物过滤滑块（5.7.6）
      │     ├── <FocusPanel />        // 聚焦侧边栏（5.7.4）
      │     ├── <ExportMenu />        // 导出菜单（5.7.5）
      │     └── <RelationPopover />   // Hover 关系详情浮窗
      │
      ├── <CastEditor>                // 人名册编辑（5.8）
      │     ├── 人物列表 + 搜索
      │     ├── 别名编辑
      │     └── 合并操作
      │
      └── <ChapterResultViewer>       // 单章账本查看
            └── 展示该章 relations + evidences
```

### 6.2 GraphView 状态管理

```typescript
interface GraphViewState {
  // 数据
  graphData: GraphData;              // 从 GET /graph 获取

  // 筛选状态（触发后端重新查询）
  chapterRange: [1, number];         // 章节滑块
  minAppearance: number;             // 过滤阈值，默认 2
  typeFilter: string[];              // 关系类型筛选

  // 前端纯展示状态（不触发后端查询）
  renderMode: 'text' | 'avatar';    // 渲染样式
  focusPersonId: string | null;      // 聚焦的人物
  showSuppressed: boolean;           // 是否显示被压制的软关系
  showSecondary: boolean;            // 聚焦时是否展开二度关系
}

// 筛选状态变化 → debounce 200ms → 调 GET /graph → 更新 graphData
// 展示状态变化 → 纯前端重渲染 G6 图
```

### 6.3 G6 图谱渲染策略

```typescript
// 节点样式映射
function getNodeStyle(node: GraphNode) {
  const baseSize = node.importance === 'main' ? 48
                 : node.importance === 'supporting' ? 36 : 24;

  return {
    size: baseSize,
    opacity: node.importance === 'minor' ? 0.5 : 1,

    // 头像框模式额外属性
    type: state.renderMode === 'avatar' ? 'circle' : 'rect',
    borderColor: node.gender === 'male' ? '#4096ff'
               : node.gender === 'female' ? '#ff85c0'
               : '#d9d9d9',
    borderWidth: 2,
    icon: state.renderMode === 'avatar' ? node.avatar : undefined,
    label: node.name,
    labelPosition: 'bottom',
  };
}

// 边样式映射
function getEdgeStyle(edge: GraphEdge) {
  const primaryTag = edge.tags.find(t => !t.suppressed) ?? edge.tags[0];

  return {
    type: primaryTag.tier === 'hard' ? 'line'        // 实线
        : primaryTag.tier === 'mid'  ? 'line-dash'   // 虚线
                                     : 'dot',         // 点线
    endArrow: primaryTag.directed,
    label: edge.tags.map(t => t.type).join(', '),     // 多标签
    labelBackground: true,
  };
}

// 聚焦模式（一度默认；showSecondary 时扩到二度）
function applyFocus(graph: G6Graph, personId: string, showSecondary: boolean) {
  const degree1 = getNeighbors(graph, personId, 1);
  const degree2 = showSecondary
    ? getNeighbors(graph, personId, 2).filter(id => !degree1.includes(id) && id !== personId)
    : [];
  const keep = new Set([personId, ...degree1, ...degree2]);

  // 中心强制显示；一度正常；二度可降透明度；其余隐藏
  // 边：仅保留端点均在 keep 内的边；侧边栏勾选 type 再二次过滤
  // 与 min_appearance：中心无视阈值；二度邻居仍可沿用当前 graphData 已过滤结果
}
```

### 6.4 导出实现

| 格式 | 实现 |
|------|------|
| PNG | G6 原生 `graph.toDataURL()` → 合成图例水印 → 下载 |
| SVG | G6 原生 `graph.toSVG()` |
| JSON | 直接序列化当前 `graphData` |
| Mermaid | 遍历 edges 生成 `graph LR` 语法（后置） |

水印合成（Canvas 叠加）：

```
┌─────────────────────────────┐
│                             │
│       [图谱内容]              │
│                             │
├─────────────────────────────┤
│ 红楼梦 · 前 80 章 · 头像框模式 │  ← 水印条
│ ■ hard  ┄ mid  · soft        │  ← 图例
└─────────────────────────────┘
```

---

## 7. 关键流程时序

### 7.1 上传 → 分析 → 出图（完整流程）

```
前端                后端 API              Orchestrator          Agent / LLM
 │                    │                      │                     │
 │ POST /upload       │                      │                     │
 │──────────────────▶│                      │                     │
 │   book_id          │  解析 EPUB            │                     │
 │◀──────────────────│  落盘 chapters/       │                     │
 │                    │                      │                     │
 │ POST /analyze      │                      │                     │
 │──────────────────▶│  start()             │                     │
 │   202 Accepted     │─────────────────────▶│                     │
 │                    │                      │                     │
 │                    │         [可选] NLP Cast Pass（二期）        │
 │                    │                      │── 扫正文 NER ───────▶│
 │                    │                      │   cast 草稿          │
 │                    │                      │◀────────────────────│
 │                    │                      │                     │
 │                    │         波次并行 Chapter Agent (W=5)       │
 │                    │         snapshot@frontier 共享              │
 │                    │                      │────────────────────▶│
 │ GET /progress (SSE │                      │  wave 提交 + barrier │
 │◀──────────────────│◀─────────────────────│────────────────────▶│
 │  event: progress   │                      │  frontier 推进       │
 │  ch42/120          │                      │         ...         │
 │                    │                      │  frontier=target     │
 │  event: done       │                      │                     │
 │◀──────────────────│◀─────────────────────│                     │
 │                    │                      │                     │
 │ GET /graph?to=80   │                      │                     │
 │──────────────────▶│  Aggregator.compile() │                     │
 │   GraphData JSON   │  读 ledger + 合并     │                     │
 │◀──────────────────│  算分 + 过滤          │                     │
 │                    │                      │                     │
 │ 渲染 G6 图谱        │                      │                     │
```

### 7.2 前端交互：章节滑块拖动

```
用户拖动滑块 to_chapter=50
  │
  ├─▶ 更新 state.chapterRange = [1, 50]
  ├─▶ debounce 200ms
  ├─▶ GET /graph?to_chapter=50&min_appearance=2
  │     └─▶ 后端 Aggregator 重算：
  │           - 只读 ledger/ch_001~050
  │           - appearance_count 按前 50 章重算
  │           - 过滤 + 合并 + 算分
  ├─▶ 收到新 GraphData
  └─▶ G6 diff 更新（增删节点/边，保留已有布局位置）
```

### 7.3 前端交互：人物聚焦

```
用户点击「贾宝玉」节点
  │
  ├─▶ state.focusPersonId = 'p001'      （纯前端，不请求后端）
  ├─▶ 计算一度邻居集合 neighbors
  ├─▶ G6 操作：
  │     - 贾宝玉 → 放大 + 高亮
  │     - neighbors → 正常显示
  │     - 其余节点 → 隐藏
  │     - 非贾宝玉的边 → 隐藏
  ├─▶ 渲染 <FocusPanel>：
  │     - 展示人物信息
  │     - 列出所有关系（可勾选筛选）
  └── 用户点击「退出聚焦」→ 恢复全局视图
```

---

## 8. 人工校对闭环

```
                    ┌──────────┐
                    │ 自动分析  │
                    └────┬─────┘
                         │
                         ▼
              ┌──────────────────┐
              │  人名册编辑       │
              │  (改名 / 别名)    │
              └────────┬─────────┘
                       │ 合并两人
                       ▼
              ┌──────────────────┐
              │  确定性 rewrite   │  ← 全库 ledger person_id 替换
              │  （默认不重跑 LLM）│
              └────────┬─────────┘
                       │
                       ▼
              ┌──────────────────┐
              │  关系增删改       │  ← 只写 override 层
              └────────┬─────────┘
                       │
                       ▼
              ┌──────────────────┐
              │  重新汇总出图     │  ← GET /graph 自动反映变更
              └──────────────────┘
```

### 8.1 Override 是唯一人工修正路径

原始 `ledger/` **不由人工 API 直接改写**（Agent 重跑除外）。人工关系修正只进 override：

```
/workspace/{book_id}/
├── ledger/               # Agent 产出（重跑可覆盖单章）
│   └── chapter_003.json
└── overrides/
    ├── cast_overrides.json
    └── relation_overrides.json
        {
          "add": [
            {
              "person_a": "p001",
              "person_b": "p005",
              "type": "表亲",
              "chapter_id": 3,
              "note": "人工补录",
              "quote": null
            }
          ],
          "remove": [
            {
              "chapter_id": 3,
              "person_a": "p001",
              "person_b": "p002",
              "type": "朋友"
            }
          ]
        }

汇总时：先读 ledger → apply overrides → 再聚合
remove 键：无向按规范化 (min,max,type,chapter_id)；有向 (from,to,type,chapter_id)
```

### 8.2 人名合并（便宜路径优先）

```
POST /cast/merge { keep_id, drop_id }
  1. cast：别名并入 keep，删除 drop；记入 merge 审计
  2. 扫全部 ledger + overrides：drop_id → keep_id（确定性）
  3. 自环边丢弃；重复 (a,b,type) 合并证据
  4. 失效 Aggregator 缓存
  5. 不默认重跑 LLM；若用户认为映射质量差，再对指定章 rerun
```

改正式名/别名：只动 cast；已有 ledger 的 person_id 不变。仅当别名体系大改且用户主动要求时，才批量 rerun。

---

## 9. 非功能设计

### 9.1 成本控制

| 措施 | 说明 |
|------|------|
| 章结果缓存 | ledger/chapter_*.json 落盘，重跑只跑指定章 |
| 工具步数上限 | 单章默认 20 步；长章按窗数抬高（§4.3.1） |
| 正文窗控 | `inject_max_chars` / `read_window_chars`；非分析章默认不进队列 |

| 双模式并行 | many_chapters 波次 W 可配；few_long 全章并行 + 终局质检；合并人名用 rewrite |
| LLM 并发闸 | 全局 semaphore；与并行章数共同限制 in-flight 请求 |
| 模型可配置 | 章分析 / Reconcile 可分模型档；Cast Pass（P1）为 NLP，默认不耗 LLM |
| 采样策略 | 长篇 Cast Pass（P1）可分卷采样，不全量扫描 |
| 密钥 | 仅服务端 `.env`；不进仓库、不进前端 bundle |

### 9.1.1 工程硬化（**P2**，见 §2.2.3）

path jail、catalog 索引、jobs 框架、request_id、完整可观测等——**主路径跑通且真痛再做**，不占 P0。

### 9.2 中断与恢复

```
SQLite 中维护:
  chapters_status(
    book_id TEXT,
    chapter_id INT,
    status TEXT,     -- pending | running | done | failed
    wave_id INT,     -- 所属波次（可选）
    started_at,
    finished_at
  )

  analysis_frontier(book_id) → 连续 done 前缀

重启时:
  status=running → 标 failed（半波未提交的缓冲丢弃）
  status=done → 跳过
  frontier = 最大连续 done 前缀
  从 frontier+1 起重新组波（含 failed 重试策略可配置）
```

### 9.3 可复现

- 每章 ledger 是独立 JSON 文件，可 diff；产品路径修正走 override，调试时可直接改文件但需知会缓存失效
- Agent 工具调用日志可落盘（可选）；波次提交后的 cast_version / frontier 可追溯
- 人名册版本可追溯（每次 CastWriter / 人工编辑 bump version）

---

## 10. 目录结构（拟定）

```
CastAtlas/
├── docs/
│   ├── PRD.md
│   └── ARCHITECTURE.md          ← 本文件
│
├── backend/                      # Python 后端
│   ├── app/
│   │   ├── main.py               # FastAPI 入口、CORS、薄 exception handler
│   │   ├── config.py             # 环境配置
│   │   ├── errors.py             # AppError + 少量 code（可日后拆包）
│   │   ├── api/
│   │   │   ├── books.py
│   │   │   ├── analysis.py
│   │   │   ├── graph.py
│   │   │   ├── correction.py
│   │   │   └── meta.py           # 可选：relation-types
│   │   ├── domain/
│   │   │   └── relation_types.py # 关系枚举 SSOT（P0）
│   │   ├── core/
│   │   │   ├── parser.py
│   │   │   ├── orchestrator.py   # 含简单「分析中」状态；无 jobs 框架
│   │   │   ├── aggregator.py
│   │   │   └── memory.py         # P1
│   │   ├── agent/                # LC 运行时
│   │   │   ├── chapter_agent.py
│   │   │   ├── reconcile_agent.py
│   │   │   ├── cast_writer.py
│   │   │   ├── scheduler.py
│   │   │   ├── tools.py
│   │   │   ├── llm.py
│   │   │   ├── cast_pass_nlp.py  # P1
│   │   │   └── prompts/
│   │   │       ├── chapter.py
│   │   │       └── reconcile.py
│   │   ├── models/               # Pydantic
│   │   │   ├── book.py
│   │   │   ├── cast.py
│   │   │   ├── ledger.py
│   │   │   └── graph.py
│   │   └── storage/
│   │       ├── database.py       # 单书状态等
│   │       └── filestore.py      # workspace/{book_id}/ 读写（普通路径）
│   ├── requirements.txt
│   ├── pyproject.toml
│   └── .env.example
│
├── frontend/
│   ├── src/
│   │   ├── App.tsx
│   │   ├── pages/
│   │   ├── components/
│   │   │   ├── GraphView/        # 文字图 / 聚焦 / 导出（P0）
│   │   │   ├── CastEditor/
│   │   │   └── ...
│   │   ├── hooks/
│   │   ├── types/
│   │   └── api/client.ts
│   ├── package.json
│   └── vite.config.ts
│
└── workspace/                    # gitignore；P0 无全局 catalog
    └── {book_id}/
        ├── meta.json
        ├── chapters/
        ├── cast.json
        ├── ledger/
        ├── memory/               # P1
        ├── overrides/
        └── castatlas.db
```

**P2 若做硬化再补：** `storage/paths.py`（jail）、`catalog.py`、`core/jobs.py`、`middleware/request_id.py` 等——见 §2.2.3，**不要预建空壳。**

---

## 11. 开放问题（技术向）

| 问题 | 备注 | 状态 |
|------|------|------|
| LLM / Agent 框架 | **LangChain 仅作 Agent 运行时**（tools + prompts + loop + ChatModel）；编排自研 | **v0.5 已定** |
| 部署形态 | 本机个人；默认信任操作者 | **v0.7 强调** |
| 关系枚举 SSOT | `domain/relation_types.py`（P0） | **已定** |
| 错误处理 | 薄 AppError + handler；小码表 | **P0 薄做** |
| path jail / catalog / jobs 框架 | 工程硬化 | **P2（三期）**，非 P0 |
| LLM Provider 默认厂商/模型 | OpenAI 兼容；实现时定默认 | P0 可配即可 |
| G6 v5 | 一期纯文字节点 | 暂定 G6 |
| 并行调度 | few_long **P0**；many_chapters+记忆 **P1** | **已定** |
| cast 并发写 | Cast Writer 单写（实现时够用即可） | **已定方向** |
| override vs 改 ledger | 人工只走 override | **已定** |
| Cast Pass | NLP；辅助 | **P1** |
| 鉴权 / 多用户 | 不做 | 除非产品改形态 |
| 联网百科补人名 | 不做主路径 | **不做** |

---

## 12. 修订记录

| 版本 | 日期 | 说明 |
|------|------|------|
| v0.1 | 2026-07-14 | 首版架构设计：前后端分层、数据模型、API、Agent 管线、组件树 |
| v0.2 | 2026-07-14 | 波次并行与记忆快照；Cast Writer；关系键/枚举修正；override 唯一路径等 |
| v0.3 | 2026-07-14 | 双模式调度：many_chapters 波次并行；few_long 全章并行 + 终局 Check/Merge Agent |
| v0.4 | 2026-07-14 | NLP Cast Pass 定稿（辅助）；与 PRD 对齐分期：一期主路径+文字图谱，二期 NLP/记忆/头像框 |
| v0.5 | 2026-07-15 | Agent 运行时定为 LangChain（工具注解、提示词模板、tool loop、OpenAI 兼容 ChatModel）；明确不替代 Orchestrator / Memory SSOT / Cast Writer / Aggregator |
| v0.6 | 2026-07-15 | 横切基础草案（后续 v0.7 按本机项目收缩） |
| v0.7 | 2026-07-15 | **本机个人前提**；path jail / catalog / jobs 等降为 **P2**；P0 只保留薄配置+关系 SSOT+薄错误处理；分期改 P0/P1/P2 |
| v0.8 | 2026-07-15 | Chapter `include_in_analysis`（解析打标，分析只调度正文）；正文 **注入优先 + `read_chapter_window` 限量续读**（取代默认整章 get）；默认阈值 10k/5k/300 |

---

## 13. 实现分期（P0 / P1 / P2）

真正大规模影响质量的是 **章内提取 + 终局归纳 + 汇总过滤**。  
工程硬化（jail、catalog、jobs 框架）对个人本机 **P0 收益为负**，放到 **P2**。

### 13.1 P0（一期 · 中篇可演示闭环）

| 域 | 交付 |
|----|------|
| 基础 | 脚手架、config、workspace（扫目录列书）、薄错误处理、**关系 SSOT**、**LLM（LC ChatModel）**、EPUB 切章、状态/SSE |
| 分析 | Chapter / Reconcile（LC prompts+tools）；**few_long** 并行→预合并→归纳；空 cast 可跑；分析中简单防重入 |
| 汇总 | Aggregator：多标签软硬、前 N 章、出现章数过滤 |
| 前端 | 纯文字图谱、聚焦、频次/章节滑块、PNG/JSON 导出、上传/进度/人名册 |
| **明确不做** | NLP Cast、记忆/波次、头像框；**path jail / catalog / jobs 框架 / request_id / health 体系** |

### 13.2 P1（二期 · 长篇辅助）

| 域 | 交付 |
|----|------|
| NLP Cast Pass | 全书 NER → cast 草稿 |
| Memory + many_chapters | 总结链、大总结、波次并行 |
| 前端 | 头像框；长篇体验 |
| 其它 | 待合并队列、quote 加强等（按痛点） |

### 13.3 P2（三期 · 硬化 / 工程化，按需）

| 域 | 交付 |
|----|------|
| 路径 | workspace path jail（若仍需要） |
| 书目 | 全局 catalog 索引（书极多或扫盘烦了再做） |
| 任务 | 正式 jobs 生命周期 / 更稳取消 |
| 可观测 | request_id、结构化日志、health 等 |
| 其它 | 仅在「真痛」时加；不为想象中的多租户预埋 |

### 13.4 依赖示意

```text
P0: Provider + EPUB → 章/归纳 Agent + few_long + Aggregator → 文字图/聚焦/导出
P1: + NLP Cast + Memory/波次 + 头像框
P2: + jail / catalog / jobs / 可观测硬化（按需，可整期不做）
```
