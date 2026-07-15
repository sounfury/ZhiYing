# CastAtlas

> 把电子书变成可导航的人物关系图。  
> 先建人名册，再按章入账；关系多标签共存，软硬有权重。

## 文档

| 文档 | 说明 |
|------|------|
| [docs/PRD.md](./docs/PRD.md) | 产品需求与设计思路（当前主文档） |
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | 技术架构（并行/记忆、API、数据模型） |

## 状态

设计阶段 · 尚未开工实现

**P0：** Provider（LC）+ EPUB + 章/归纳 + few_long + 文字图（聚焦/过滤/导出）  
**P1：** NLP Cast、记忆/波次、头像框  
**P2：** 工程硬化（jail/catalog/jobs 等，按需；本机个人默认可不做）  

> 本机个人项目；编排自研，LangChain 只做 Agent 运行时（架构 §2.1 / §2.2）。

## 名称含义

- **Cast**：书中人物表（通讯录）
- **Atlas**：长篇不是一张海报，而是可下钻的地图册
