# ZhiYing

> 把电子书变成可导航的人物关系图。  
> 先建人名册，再按章入账；关系多标签共存，软硬有权重。

## 文档

| 文档 | 说明 |
|------|------|
| [docs/PRD.md](./docs/PRD.md) | 产品：做什么、给谁、用户可见行为与范围（已实现能力） |
| [docs/PRD-beta.md](./docs/PRD-beta.md) | 内测要补的能力：示例书、账号与隔离、用量上限、PNG 导出、反馈、TXT 上传 |
| [docs/PRD-commons.md](./docs/PRD-commons.md) | 备选：公益版需求思路（公共关系库、用户自带 API Key），未排期 |
| [docs/DESIGN.md](./docs/DESIGN.md) | 设计：领域模型、分析流程、模型调用点、存储与重跑 |
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | 架构：模块分层、依赖规则、技术选型、目录 |
| [docs/acceptance/](./docs/acceptance/) | 验收场景（Gherkin） |
| [docs/todo.md](./docs/todo.md) | 待办与 Kotlin 重构实施顺序 |

## 状态

| 目录 | 内容 |
|------|------|
| `zhiying_backend/` | Kotlin 后端（Spring Boot，SQLite）：导入 EPUB → 整书分析 / 单章重跑 → 发布 → 出图与查询 |
| `frontend/` | React + AntV G6 前端：书架、关系图、章节聚焦、人物 / 章节侧栏、分析进度 |
| `eval/` | 评测集（《悉达多》标准标注）；评测在前端 `/eval` 页发起，运行记录写到 `eval/runs/`（不入库） |

全链路已用真实模型跑通；验收场景尚未落为自动化测试。待办见 [docs/todo.md](./docs/todo.md)。

## 本地跑起来

```bash
# 后端：先把 .env.example 复制为 .env，填写模型服务地址、密钥与模型名
cd zhiying_backend
./gradlew :web:bootRun        # 监听 8080，数据在 zhiying_backend/data/

# 前端（另开终端）
cd frontend
npm install
npm run dev
```

浏览器打开 **http://127.0.0.1:5173/**，在书架拖入 EPUB 上传后开始分析。Vite 已把 `/api` 代理到 `http://127.0.0.1:8080`。

开发时打开一本书后，可在地址后加 `&mockProgress=reading|post|failed|done|cancelled|rerun|many`，用假数据查看各种分析状态，不调用模型。

## 名称含义

- **知**：读懂书中人物与关系
- **影**：人物群像的投影——可导航的关系图
