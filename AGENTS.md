## 注释规则
文件顶部必须有注释，如果为纯工具，配置文件简单一句话描述功能即可，如果为业务类文件，需要描述其承担的职责

## 分层原则（zhiying_backend）
借用分层思想，不是严格 DDD：只在依赖方向需要时定义接口（应用层调用外部能力），不为假想的换技术栈写适配代码。以下三条必须遵守，其余自由发挥：
1. 依赖方向：web → application → domain，infrastructure → application → domain；web 只在运行时装配 infrastructure；domain 不依赖框架、网络、文件、数据库。
2. 充血领域模型：不变量与业务规则写在领域对象上，不写贫血数据类再由外部服务改字段。
3. 编排层突出副作用：application 用例按顺序显式写出读取、调用模型、写入、发布等副作用；domain 只做纯计算。

基础约定（详见 docs/ARCHITECTURE.md）：对外错误统一登记到 `ErrorCode` 并抛 `AppException`；可调参数统一加到 `zhiying.*` / `ZhiYingProperties`，不用 `@Value`；不建 common 模块。

## 文档规则（docs/）
每类内容只有一个归属，不新开平行设计稿；改设计就直接改对应文档：
- `PRD.md`：做什么、给谁、用户可见行为与范围。不写系统内部怎么实现（数据结构、公式、调用流程）。
- `DESIGN.md`：领域模型、分析流程、模型调用点、存储与重跑。产品规则只引用 PRD 章节，不重复抄写。
- `ARCHITECTURE.md`：模块分层、依赖规则、技术选型、目录。
- `acceptance/`：Gherkin 验收场景；新产品决定先写 PRD 再同步场景。
- `todo.md`：实施顺序、待办；做完即删。
