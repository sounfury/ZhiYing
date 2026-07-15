## Why

CastAtlas 目前只有设计文档（PRD + ARCHITECTURE），尚无任何代码。一期目标需要上传 EPUB → 章分析 → 出图的完整链路，第一步必须搭建后端（FastAPI）与前端（React + Vite）的工程脚手架，并落地配置系统、LLM Provider 抽象、全局异常处理、数据模型和存储层骨架，使后续功能开发有稳固的地基。

## What Changes

- **后端脚手架**：创建 `backend/` Python 项目，含 FastAPI 入口、虚拟环境管理（pip + venv + requirements.txt）、.env 配置
- **前端脚手架**：创建 `frontend/` React + TypeScript + Vite 项目，含 Ant Design、AntV G6 依赖、基础路由和 API 封装
- **配置系统**：基于 pydantic-settings 的 Settings 类，从 `.env` 读取 LLM、存储、分析参数
- **全局异常处理**：统一错误码枚举（分域：COMMON / BOOK / PROVIDER / ANALYSIS / CAST / GRAPH）、CastAtlasError 异常体系、FastAPI exception_handler 统一 ErrorResponse 响应
- **LLM Provider**：抽象 LLMProvider ABC + OpenAICompatibleProvider 实现，base_url / api_key / model 全可配，不绑定厂商
- **数据模型**：Pydantic v2 模型定义 BookMeta / Chapter / Cast / Person / ChapterLedger / Relation / GraphData 等
- **存储层骨架**：aiosqlite SQLite 连接管理 + JSON filestore 文件读写
- **API 路由骨架**：books / analysis / graph / correction 四组路由的空壳注册
- **仓库配置**：.gitignore（含 workspace/、venv/、node_modules/）、.env.example、run 脚本

## Capabilities

### New Capabilities

- `project-scaffold`: 项目目录结构、前后端脚手架、依赖管理、仓库配置（.gitignore / .env.example）
- `config-system`: 集中式配置管理，从环境变量读取 LLM / 存储 / 分析参数
- `error-handling`: 统一错误码体系、异常类层次、FastAPI 全局异常处理器、标准 ErrorResponse schema
- `llm-provider`: LLM 调用抽象层，支持 OpenAI 兼容协议，可配置切换厂商和模型
- `data-models`: 核心数据结构的 Pydantic 模型定义（Book / Chapter / Cast / Ledger / Graph）
- `storage-layer`: SQLite 数据库连接管理 + JSON 文件存储的骨架实现

### Modified Capabilities

（无——此为首期基础设施，不修改已有能力）

## Impact

- **新增代码**：`backend/app/` 全部模块、`frontend/src/` 脚手架、配置文件、仓库根配置
- **新增依赖**：
  - 后端：fastapi, uvicorn, pydantic, pydantic-settings, openai, ebooklib, beautifulsoup4, aiosqlite, python-multipart
  - 前端：react, react-dom, antd, @antv/g6, react-router-dom, axios, typescript
- **运行时**：需 Python 3.9+ 和 Node.js 22+，通过 venv 和 npm 管理依赖
- **API**：FastAPI 应用可启动并返回健康检查，所有路由注册但暂返回 501 Not Implemented
- **不涉及**：EPUB 解析逻辑、Agent 管线、图谱渲染逻辑均不在本次范围（仅骨架文件）