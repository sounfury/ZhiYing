# 开放关系体系

本项目尚未上线，本次直接切换数据结构，不兼容或迁移旧 type/tier 账本和补丁。旧测试书请重新导入分析。

## 数据与注册表

关系事实保存 relation_id、人物端点、raw_relation、label、category、definition、directed、subject_role、object_role 和 evidence。raw_relation 始终保留文本中的具体表述；category 仅用于展示分组和筛选，不是合法类型枚举。无向关系要求双方角色一致，有向关系按 a 的角色 → b 的角色表达。

predicate 是规范化后的语义标识，不以中文标签作为主键。normalization_status（pending / resolved）与证据 status（pending / confirmed / rejected）独立。没有确定归类的关系也可以具有已确认的原文证据，以原文标签单独显示；不同未归类事实不因标签相同而被自动合并。

relation_seeds.json 提供初始示例而不是封闭列表。运行时每本书维护 relation_registry.json，包含 predicate、标签、定义、角色、别名、分类和 display_priority。新类型由服务端生成稳定标识，归入该书注册表；不会污染别的书。

## 执行流程

1. 多章并行抽取开放关系描述；工具只校验结构、人物 ID、自环和引用位置，不限制关系名称，不接受模型自报 predicate 或确认状态。
2. 合并临时人物 ID 后，按章节串行归一化关系。定义完全一致时直接复用；其余由独立模型判断语义等价、全新语义或待处理。反向表述可以转换人物顺序与角色，但保留 raw_relation。后续章节能看到之前新增的定义，避免并发创建同义类型。
3. 独立验证连续原句是否存在、人物和角色是否对应、关系是否有证据。归一化和验证都复用 LLM_RECONCILE_MODEL（未配置时回退主模型），归一化异常不会阻止原文事实继续接受验证。
4. 先保存注册表，再保存账本。总校对新增关系也走相同处理流程。模型异常保留候选；存储异常进入失败结果，不让 SSE 一直等待。
5. 聚合器仅展示证据 confirmed 的关系，按 predicate 和方向聚合。归一化未完成时按 relation_id 保留独立标签。不同类型不再互相压制，展示分只是注册表优先级加出现章数，不是可信度。

语义判断由模型完成，结构与流程测试不能证明真实文本的准确率；本次没有建立人工评测集。

## API 与前端

- GET /api/books/{book_id}/relation-types：当前书的初始及新增关系元数据。
- POST /api/books/{book_id}/relation-types：人工提交开放描述，注册具体语义。
- GET /api/books/{book_id}/graph：支持 predicate_filter 和 category_filter，两者同时提供时取交集；返回 label、角色、原文表述、归一化状态及证据。
- PUT /api/books/{book_id}/relations：add 接受完整关系对象，remove 接受 relation_id 字符串列表；人工添加视为确认。注册表与补丁更新共用书级启动锁，避免与分析启动争抢写入。
- 总校对 relation_changes 使用 {action: add, relation: {...}} 或 {action: remove, relation_id: ...}。不再按人物对与类型名批量删除。
- 导出包含 relation_registry、各章账本及完整补丁。

前端不维护固定关系副本。它读取当前书注册表，按分类和具体语义筛选；连线显示实际标签，详情显示角色、原文与未归类状态。新分类有默认样式，不需要前端新增类型分支。

## 完整性与边界

账本 analysis_status 为 complete 或 partial。自动收尾、正文未读完、模型服务异常会保留原因并标记部分完成。书籍状态、SSE 和前端提示同步该状态；chapters_done 表示已入账章节，包含 chapters_partial。

本次重构关系体系；人物身份消歧及剧情时间线仍沿用现有实现。当前注册表使用逐关系归一化，增加模型调用量；未做按语义检索缩小注册表候选集的优化。

## 功能验证

在项目根目录执行：

```powershell
backend/.venv/Scripts/python.exe -m pytest backend/tests -q
npm run build --prefix frontend
```

回归覆盖新关系注册、同义复用、方向反转、类型与证据状态独立、书籍隔离、按 ID 撤销、章节切片和完整编排链路。所有模型调用使用测试替身。
