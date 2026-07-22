## ADDED Requirements

### Requirement: PatchApplier 应用合并建议
系统 SHALL 在 PatchApplier._apply_merges 中处理 patch.merges，对每个 MergeSuggestion：(1) 将 drop_id 的别名并入 keep_id 的 aliases；(2) 从 cast 中删除 drop_id person；(3) 扫描全部 ledger 将 drop_id → keep_id（persons / relations / events）；(4) 自环边丢弃；重复 (a,b,type) 合并证据。cast.version SHALL 递增。

#### Scenario: 合并两人
- **WHEN** patch.merges 有 {keep_id="p001", drop_id="p003", reason="..."}
- **THEN** p003 的别名并入 p001；cast 中删除 p003；ledger 中 p003 全部替换为 p001

#### Scenario: 合并导致自环丢弃
- **WHEN** 合并后 ledger 出现 person_a == person_b 的关系
- **THEN** 该自环边被丢弃

### Requirement: PatchApplier 应用别名建议
系统 SHALL 在 PatchApplier._apply_aliases 中处理 patch.aliases，对每个 AliasSuggestion：在对应 person 的 aliases 中添加 new_aliases 中尚不存在的名字。person_id 若受 merge 影响（被 remap），SHALL 先做 remap 再操作。

#### Scenario: 添加新别名
- **WHEN** patch.aliases 有 {person_id="p001", new_aliases=["宝哥哥"]}
- **THEN** p001 的 aliases 新增"宝哥哥"（若已存在则跳过）

### Requirement: PatchApplier 应用关系修改
系统 SHALL 在 PatchApplier._apply_relation_changes 中处理 patch.relation_changes，写入 `overrides/relation_overrides.json`。`action="add"` 的条目 SHALL 追加到 overrides["add"] 列表；`action="remove"` 的条目 SHALL 追加到 overrides["remove"] 列表。person_id 受 merge 影响时 SHALL 先做 remap。type 必须在 RELATION_TYPES 枚举内，否则跳过该条并记录警告。

#### Scenario: 添加关系到 overrides
- **WHEN** patch.relation_changes 有 {action="add", person_a="p001", person_b="p005", type="表亲", chapter_id=3}
- **THEN** overrides/relation_overrides.json 的 "add" 列表新增该条

#### Scenario: 删除关系到 overrides
- **WHEN** patch.relation_changes 有 {action="remove", person_a="p001", person_b="p002", type="朋友", chapter_id=3}
- **THEN** overrides/relation_overrides.json 的 "remove" 列表新增该条

#### Scenario: 非法 type 被跳过
- **WHEN** patch.relation_changes 有 {action="add", type="恋人"（不在枚举内）}
- **THEN** 跳过该条，记录日志警告，不写入 overrides

### Requirement: PatchApplier 写待办
系统 SHALL 在 PatchApplier._apply_todos 中将 patch.todos 写入 `workspace/{book_id}/todo_list.json`。格式为 `[{"description": "...", "person_ids": [...], "chapter_ids": [...]}]`。

#### Scenario: 写待办
- **WHEN** patch.todos 有 2 条待办
- **THEN** todo_list.json 写入 2 条记录

### Requirement: PatchApplier 写校对报告
系统 SHALL 在 apply() 完成后写 `workspace/{book_id}/reconcile_report.json`，包含时间戳、可疑项计数、patch 原文、apply 结果摘要（merges_applied / aliases_applied / relation_changes_applied / todos_written）。

#### Scenario: 正常应用后写报告
- **WHEN** patch 含 2 merges, 1 alias, 3 relation_changes, 1 todo，全部成功应用
- **THEN** reconcile_report.json 记录各计数，patch 字段保存原始 patch

### Requirement: PatchApplier 应用顺序
PatchApplier.apply() SHALL 按以下顺序应用：(1) merges（改全库 id）；(2) aliases（在 merge 后操作，因 remap）；(3) relation_changes（在 merge 后操作）；(4) todos。任一步骤异常 SHALL 记录错误并继续后续步骤（尽力应用），最终在结果中标记异常。

#### Scenario: 合并影响后续别名操作
- **WHEN** patch.merges 有 p003→p001，patch.aliases 有 {person_id="p003", new_aliases=["..."]}
- **THEN** 别名操作先 remap p003→p001，再给 p001 添加别名