# ZhiYing 开发进度

## 当前状态

后端 P0 主路径跑通，前端最小预览可用。实测 5 章并行分析 0 失败。

---

## 已完成

### 后端

- EPUB 上传 → 切章 → 落盘
- Chapter Agent（LangChain tool-calling loop）
- Reconcile Agent（终局校对 + patch 应用）
- Orchestrator（few_long 并行 + CastWriter + SSE 进度）
- Aggregator（多标签软硬 + 前 N 章切片 + 出现章数过滤）
- 关系枚举 SSOT
- 人名册读写
- 分析中断/停止
- 6 个 API 端点 501 未实现（rerun / cast 编辑 / relations override / cast merge / export / graph 已实现）

### Agent 工具链（本轮优化）

- `propose_persons`：批量提议人物（1 步搞定全章人物）
- `submit_relations`：关系分批累积提交（可多次调用）
- `submit_result`：只传 summary 收尾（persons 自动派生，events 去掉）
- 正文缓存：ChapterToolContext / ReconcileToolContext 不再每次读盘
- 步数计时日志：每步 llm_ms / tool_ms，整章总耗时

### 前端（本轮重构）

- App.tsx 从 655 行拆为 ~170 行薄编排器
- 4 个 hooks：useBooks / useChapters / useGraphData / useAnalysis
- 4 个组件：HeaderBar / ControlPanel / AnalysisProgress / DetailPanel
- G6 扇区太阳系布局，节点/边点击详情，人物聚焦

### 基础设施

- 日志落盘 `backend/logs/app.log`（stderr + 文件双输出）
- 48 个后端测试全过

---

## 未做

### 后端 501 端点

- `POST /chapters/{cid}/rerun` — 单章重跑
- `PUT /cast` — 人名册编辑
- `PUT /relations` — 关系人工修正（override）
- `POST /cast/merge` — 人名合并
- `GET /export` — 导出

### 前端待加

- PNG / JSON 导出
- 人名册编辑器（CastEditor）
- 单章账本查看
- 关系类型筛选
- 布局策略切换（force / tree）

### P1（二期）

- NLP Cast Pass（全书人名扫描）
- 章间记忆 / 波次并行（many_chapters 模式）
- 头像框渲染模式

---

## 实测数据（2026-07-28）

测试书：《一个青年艺术家的画像》5 章

| 章 | 字符 | 步数 | 耗时 | 关系数 |
|---|------|------|------|--------|
| ch=5 | 18K | 10 | 46s | — |
| ch=4 | 32K | 11 | 50s | — |
| ch=6 | 61K | 21 | 79s | — |
| ch=3 | 29K | 13 | 96s | 43 |
| ch=2 | 35K | 21 | 104s | 44 |

5 章并行总墙钟 ~2分42秒，Reconcile 7步 57秒。LLM 调用占 99.9%，工具执行可忽略。