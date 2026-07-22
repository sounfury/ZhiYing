## ADDED Requirements

### Requirement: detect_cast_conflicts 函数
系统 SHALL 提供模块级函数 `detect_cast_conflicts(cast: Cast) -> list[CastConflict]`，检测人名册中可能需合并的人物对。检测规则：(1) `alias_overlap`—两人的别名集合有交集；(2) `name_alias_cross`—A 的正式名等于 B 的某个别名（或反之）。`canonical_name` 相同的两人 SHALL 跳过（已被 CastWriter 合并）。

#### Scenario: 别名重叠检测
- **WHEN** cast 中 p001 别名含"林妹妹"，p002 别名也含"林妹妹"
- **THEN** 返回 CastConflict{person_a_id="p001", person_b_id="p002", reason="alias_overlap", aliases_overlap=["林妹妹"]}

#### Scenario: 正式名与别名交叉检测
- **WHEN** cast 中 p001.canonical_name="宝玉"，p002.aliases 含"宝玉"
- **THEN** 返回 CastConflict{person_a_id="p001", person_b_id="p002", reason="name_alias_cross", aliases_overlap=["宝玉"]}

#### Scenario: 同名跳过
- **WHEN** cast 中两人 canonical_name 相同（不应出现但防御性处理）
- **THEN** 跳过该对，不生成 conflict

### Requirement: detect_relation_conflicts 函数
系统 SHALL 提供模块级函数 `detect_relation_conflicts(ledgers: list[ChapterLedger]) -> list[RelationConflict]`，扫描全部 ledger 检测同一对人之间的关系冲突。冲突类型：(1) `type_clash`—同一无向对在不同章给了不同 hard type；(2) `direction_clash`—同一有向关系对同一 type 方向相反。

#### Scenario: 类型冲突检测
- **WHEN** ch3 ledger 有 (p001,p005,表亲)，ch5 ledger 有 (p001,p005,夫妻)，均为 hard 无向
- **THEN** 返回 RelationConflict{person_a="p001", person_b="p005", conflict_type="type_clash", chapters=[3,5]}

#### Scenario: 方向冲突检测
- **WHEN** ch3 ledger 有 (p001→p002,师徒)，ch5 ledger 有 (p002→p001,师徒)
- **THEN** 返回 RelationConflict{person_a="p001", person_b="p002", conflict_type="direction_clash", chapters=[3,5]}

#### Scenario: 无冲突
- **WHEN** 全部 ledger 中同一对人的关系类型一致且方向一致
- **THEN** 返回空列表

### Requirement: detect_missing_evidence 函数
系统 SHALL 提供模块级函数 `detect_missing_evidence(ledgers: list[ChapterLedger]) -> list[MissingEvidence]`，检测 hard 关系但 evidence.quote 为空的条目，作为"去查一下"提示。此检测 SHALL NOT 阻塞主流程。

#### Scenario: hard 关系缺少原句
- **WHEN** ch3 ledger 有 Relation(type="夫妻", tier="hard")，evidence.quote 为空
- **THEN** 返回 MissingEvidence{person_a, person_b, type="夫妻", chapter_id=3}

#### Scenario: soft 关系缺 quote 不报
- **WHEN** ch3 ledger 有 Relation(type="朋友", tier="soft")，evidence.quote 为空
- **THEN** 不生成 MissingEvidence（仅检测 hard 关系）

### Requirement: SuspectsGenerator 类
系统 SHALL 提供 `SuspectsGenerator` 类，组合 `detect_cast_conflicts`、`detect_relation_conflicts`、`detect_missing_evidence` 三个函数，通过 `generate(cast, ledgers)` 方法返回 `SuspectList`。`SuspectList` SHALL 提供 `is_empty` 属性，当三个列表均为空时返回 `True`。

#### Scenario: 有可疑项
- **WHEN** cast 有 2 个别名冲突，ledger 有 1 个关系冲突，0 个缺证据
- **THEN** SuspectList.is_empty == False，cast_conflicts 有 2 项，relation_conflicts 有 1 项

#### Scenario: 无可疑项
- **WHEN** cast 无冲突，ledger 无关系冲突，无缺证据
- **THEN** SuspectList.is_empty == True