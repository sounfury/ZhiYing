# ZhiYing

> 把电子书变成可导航的人物关系图。  
> 先建人名册，再按章入账；关系多标签共存，软硬有权重。

## 文档

| 文档 | 说明 |
|------|------|
| [docs/PRD.md](./docs/PRD.md) | 产品目标与长期需求 SSOT |
| [docs/human/分析流水线.md](./docs/human/分析流水线.md) | 当前分析流水线：哪一步调用哪个 Agent，哪一步是纯逻辑 |
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | 2026-07 架构设计稿；与代码不一致时以分析流水线为准 |
| [docs/design/重构方案.md](./docs/design/重构方案.md) | 关系后处理 V2 目标方案，Phase 2 起尚未实施 |

## 状态

后端 P0 主路径已可用（上传 → 章分析 → Reconcile → Aggregator 出图）。  
前端为**最小预览**（选书 / 调参 / G6 力导向图）。

## 本地跑起来

```bash
# 后端
cd backend
source .venv/bin/activate   # 或 python -m venv .venv && pip install -r requirements.txt
PYTHONPATH=. uvicorn app.main:app --reload --host 127.0.0.1 --port 8000

# 前端（另开终端）
cd frontend
npm install
npm run dev
```

浏览器打开 **http://127.0.0.1:5173/**  

仓库带一本演示书 `悉达多`（`workspace/demo-siddhartha`，已分析，可直接出图）。  
Vite 已把 `/api` 代理到 `http://127.0.0.1:8000`。

## 名称含义

- **知**：读懂书中人物与关系
- **影**：人物群像的投影——可导航的关系图
