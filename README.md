# ZhiYing

> 把电子书变成可导航的人物关系图。  
> 先建人名册，再按章入账；关系多标签共存，软硬有权重。

## 文档

| 文档 | 说明 |
|------|------|
| [docs/PRD.md](./docs/PRD.md) | 产品：做什么、给谁、用户可见行为与范围 |
| [docs/PRD-commons.md](./docs/PRD-commons.md) | 备选：公益版需求思路（公共关系库、用户自带 API Key），未排期 |
| [docs/DESIGN.md](./docs/DESIGN.md) | 设计：领域模型、分析流程、模型调用点、存储与重跑 |
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | 架构：模块分层、依赖规则、技术选型、目录 |
| [docs/acceptance/](./docs/acceptance/) | 验收场景（Gherkin）与测试约定 |
| [docs/ci-quality.md](./docs/ci-quality.md) | Woodpecker 代码质量门禁 |
| [docs/todo.md](./docs/todo.md) | 待办 |

## 状态

| 目录 | 内容 |
|------|------|
| `zhiying_backend/` | Kotlin 后端（Spring Boot，SQLite）：导入 EPUB / TXT → 整书分析 / 单章重跑 → 发布 → 出图与查询 |
| `frontend/` | React + AntV G6 前端：书架、关系图、章节聚焦、人物 / 章节侧栏、分析进度 |
| `eval/` | 评测集（《悉达多》标准标注）；管理员在后台评测页签发起评测，只使用自己的书，运行记录写到 `eval/runs/`（不入库） |

全链路已用真实模型跑通。访客可浏览已发布示例书，登录用户上传自己的私有书（EPUB / TXT）；用量上限、秒传、反馈与管理员后台已完成；验收场景尚未落为自动化测试。待办见 [docs/todo.md](./docs/todo.md)。

## 本地跑起来

后端需要 JDK 21。首次启动先准备配置（从仓库根目录执行）：

```bash
cd zhiying_backend
cp .env.example .env
```

在 `.env` 填写模型服务地址、密钥与模型名，并增加以下管理员引导配置：

```properties
ZHIYING_ADMIN_USERNAME=admin
ZHIYING_ADMIN_PASSWORD=填写8至128字符的管理员密码
ZHIYING_COOKIE_SECURE=false
```

`ZHIYING_ADMIN_USERNAME` 默认 `admin`；首次创建管理员时必须提供 8–128 字符的密码。启动会创建一个管理员，并把已有无主书归入该管理员，保留已有书与分析数据；已有管理员时不会用引导密码重置它。后续重置密码通过管理员界面完成，并撤销目标账号的所有会话。

```bash
# 后端：在 zhiying_backend/ 执行
./gradlew :web:bootRun        # 监听 127.0.0.1:8080，数据在 data/

# 前端：另开终端，从仓库根目录执行
cd frontend
npm install
npm run dev
```

浏览器打开 **http://127.0.0.1:5173/**，先用管理员账号登录，再在书架拖入 EPUB 上传后开始分析。管理员可生成邀请码供其他用户注册。Vite 已把 `/api` 代理到 `http://127.0.0.1:8080`，浏览器会话使用同一站点的 Cookie。

开发时打开一本书后，可在地址后加 `&mockProgress=reading|post|failed|done|cancelled|rerun|many`，用假数据查看各种分析状态，不调用模型。

## 部署与示例书维护

账号安全设计见 [DESIGN §5.5](./docs/DESIGN.md#55-账号会话与书籍归属)。部署沿用上面的 `.env` 配置，公网 HTTPS 将 `ZHIYING_COOKIE_SECURE` 改为 `true`；同名环境变量优先于 `.env`。本地 HTTP 保持 `false`，否则浏览器不会在 HTTP 请求中携带会话 Cookie。会话时长配置为 `zhiying.accounts.session-lifetime`，默认 `30d`。

```bash
# 后端：从仓库根目录执行，构建后仍从 zhiying_backend/ 启动以读取 .env
cd zhiying_backend
./gradlew :web:bootJar
java -jar web/build/libs/web.jar
```

```bash
# 前端：另开终端，从仓库根目录执行
cd frontend
npm ci
npm run build
```

由反向代理在同一 HTTPS 域名提供 `frontend/dist/` 静态文件，并把 `/api` 转发至 `127.0.0.1:8080`；页面路径（包括 `/eval`）回退到 `index.html`，SSE 转发关闭响应缓冲。后端默认只监听本机，保留这一设置供本机反向代理连接；需要改监听位置时用 `SERVER_ADDRESS` / `SERVER_PORT`。前后端不开放 CORS；自有客户端发送 POST / PUT / PATCH / DELETE 等非安全方法请求时须携带 `X-Requested-With: XMLHttpRequest`。

数据库与源文件默认在 `zhiying_backend/data/`，可通过 `ZHIYING_DATA_DIR` 改为持久目录。账号上线只新增表并补齐无主书归属，保留现有数据库，不需要删库重建。`ZHIYING_ADMIN_PASSWORD` 用于首次创建管理员，修改它不能重置已有账号。

管理员上传并分析书后，在 `zhiying.examples.books` 配置固定 slug 到书 ID 的映射；现有 `portrait-of-the-artist` 可通过 `ZHIYING_EXAMPLE_PORTRAIT_ID` 指定书 ID。重启加载配置，只有已发布结果的配置示例对访客开放，公开链接使用 `/?example=portrait-of-the-artist`。管理员可重新分析配置示例，发布前访客继续看上一版；示例书不能删除或清空分析，管理员也不能读取其他用户的私有书。

原 `examples.public-only` / `ZHIYING_PUBLIC_ONLY` 开关已移除，不再用切换公开模式取得维护权限；维护须登录管理员账号。不同用户上传同一文件仅共用摘要对应的源文件，各自的书、章节、任务与结果独立，尚无秒传。

## 名称含义

- **知**：读懂书中人物与关系
- **影**：人物群像的投影——可导航的关系图
