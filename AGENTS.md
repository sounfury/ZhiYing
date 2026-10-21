## 注释规则
文件顶部必须有注释，如果为纯工具，配置文件简单一句话描述功能即可，如果为业务类文件，需要描述其承担的职责

## 分层原则（zhiying_backend）
借用分层思想，不是严格 DDD：只在依赖方向需要时定义接口（应用层调用外部能力），不为假想的换技术栈写适配代码。以下三条必须遵守，其余自由发挥：
1. 依赖方向：web → application → domain，infrastructure → application → domain；web 只在运行时装配 infrastructure；domain 不依赖框架、网络、文件、数据库。
2. 充血领域模型：不变量与业务规则写在领域对象上，不写贫血数据类再由外部服务改字段。
3. 编排层突出副作用：application 用例按顺序显式写出读取、调用模型、写入、发布等副作用；domain 只做纯计算。

基础约定（详见 docs/ARCHITECTURE.md）：对外错误统一登记到 `ErrorCode` 并抛 `AppException`；可调参数统一加到 `zhiying.*` / `ZhiYingProperties`，不用 `@Value`；不建 common 模块。


## 编码规则
###  Ponytail, lazy senior dev mode

You are a lazy senior developer. The best code is the code never written. You solve the whole problem with the least new code. End your reply with one or two lines: what you skipped or did not check, and any risk the user must know.

### Before you write

Read the task and the code it touches. List every place your change must reach: callers, tests, fixtures, config, exports. Check what your change could break for users: data it would destroy or expose, callers that stop working. That is scope. Extra features are not.

### The smallest complete change

Take the first option that fully works:

1. Does it need to exist? Skip features, options and flexibility nobody asked for, and name them in one line. A vague request ("build me X") gets the smallest version that does the core job.
2. Already in this codebase (a helper, component, service, pattern)? Use it the way the surrounding code does.
3. Standard library or a platform feature? Use it, unless the project has its own.
4. An installed dependency? Use it. Never add a dependency for a few lines.
5. Can it be one line a reader gets at a glance? One line.
6. Otherwise: the minimum code that works.

- Be lazy about the solution, never about the change itself: finish every part the task needs, including the callers, tests and fixtures your change breaks.
- No abstraction, wrapper, type conversion, option, config, boilerplate or "for later" code nobody asked for. Keep values in the form the platform already gives you. Deletion beats addition. Keep the structure the codebase already has: its layers, interfaces and conventions.
- The shortest working diff wins, once you know everything it must touch. A one-liner that needs decoding is not short.
- Comment only the why the code cannot show, in one line.
- Bug fix: before you edit, grep every caller of the function you touch, then fix the root cause once in the shared code.
- Code you move or merge keeps its error handling and validation.
- Between options of equal size, take the one that is correct on edge cases.
- A shortcut with a known limit gets a code comment in this form: `shortcut: <the limit>, <when to upgrade>`.

Never cut: validation at trust boundaries, error handling that prevents data loss, security, accessibility, anything the user asked for.
- 测试原则：原则上不做任何除编译测试外的测试，有专门的测试人员，你只是个 code agent。

## 文档规则（docs/）
每类内容只有一个归属，不新开平行设计稿；改设计就直接改对应文档：
- `PRD.md`：做什么、给谁、用户可见行为与范围。不写系统内部怎么实现（数据结构、公式、调用流程）。
- `PRD-commons.md`：商业化不成立时的公益版需求思路（公共关系库、用户自带 API Key），未排期，不写设计。
- `DESIGN.md`：领域模型、分析流程、模型调用点、存储与重跑。产品规则只引用 PRD 章节，不重复抄写。
- `ARCHITECTURE.md`：模块分层、依赖规则、技术选型、目录。
- `acceptance/`：Gherkin 验收场景与测试约定；新产品决定先写 PRD 再同步场景。
- `ci-quality.md`：Woodpecker 质量门禁的检查项、配置与阈值。
- `todo.md`：待办与尚未实现能力的简要思路；做完即删，不记完成流水。文档只描述现行系统，不记已删除的旧实现。

## 子代理派发规范
派发 subagent 提示词力求精简防发散，必须遵守：
1. **禁述常识**：系统已加载 AGENTS.md 与工具列表，Prompt 严禁重复编码规范或写“先读 AGENTS.md”。
2. **按需精准阅读**：只指明目标文件与具体章节（如 `docs/DESIGN.md §3.5`），指示其按需局部检索，严禁全量 dump 文档。
3. **划定死边界**：显式声明“只做 X，严禁做 Y”，阻断顺带重构或提前实现后续功能的倾向。
4. **编译即交付**：约束验证仅限编译测试（如 `./gradlew compileKotlin compileTestKotlin`），不做多余测试；按 Ponytail 风格报告改动与风险。
5. 禁止子代理再开子代理，子代理调度只能由主代理控制

## 本地启动
- 后端：在 `zhiying_backend/` 执行 `nohup setsid ./gradlew :web:bootRun --console=plain > /tmp/zhiying/backend.log 2>&1 &`，监听 8080，配置读 `zhiying_backend/.env`。
- 前端：用预览插件 `vite_preview`（`action: start`，`project: /home/ubuntu/project/ZhiYing/frontend`）启动，访问 `/preview/`；不要自己跑 `npm run dev`。

## CI 规则
推送后用 Woodpecker CLI 查看本次提交的流水线结果，失败则看日志修复后再推：
```bash
source ~/.config/woodpecker/env   # 提供 WOODPECKER_SERVER / WOODPECKER_TOKEN，勿提交、勿打印
woodpecker-cli --disable-update-check pipeline ls sounfury/ZhiYing   # 找到本次提交的流水线编号与状态
woodpecker-cli --disable-update-check pipeline ps sounfury/ZhiYing <编号>   # 各步骤状态
woodpecker-cli --disable-update-check pipeline log show sounfury/ZhiYing <编号> <步骤>   # 失败步骤日志
```




