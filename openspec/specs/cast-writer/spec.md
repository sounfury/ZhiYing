## ADDED Requirements

### Requirement: CastWriter 顺序 apply
系统 SHALL 实现 CastWriter，在所有 Chapter Agent 完成后（barrier），按章序顺序 apply 各章的 cast_buffer。每个 propose 的人物分配正式 person_id（格式 `p00N`，N 从 1 递增）。`canonical_name` 完全一致的 propose SHALL 合并到同一 person（别名取并集）。CastWriter SHALL 建立临时→正式 id 映射表。

#### Scenario: 首章 propose 分配正式 id
- **WHEN** CastWriter apply ch1 的 cast_buffer，其中有 ch1_p1="贾宝玉"
- **THEN** 分配正式 id "p001"，映射表记录 ch1_p1 → p001，写入 cast.json

#### Scenario: 多章同人合并
- **WHEN** ch1 propose 了 ch1_p1="贾宝玉"，ch3 也 propose 了 ch3_p1="贾宝玉"
- **THEN** CastWriter 将 ch3_p1 映射到已有的 p001，ch3_p1 的别名将并入 p001 的 aliases

#### Scenario: 别名不同但正式名相同
- **WHEN** ch1 propose ch1_p1="贾宝玉" aliases=["宝玉"]，ch2 propose ch2_p1="贾宝玉" aliases=["宝二爷"]
- **THEN** 合并后 p001 的 aliases = ["宝玉", "宝二爷"]

### Requirement: Ledger rewrite 临时 id
CastWriter apply 完成后，系统 SHALL 用临时→正式 id 映射表 rewrite 所有 ledger 文件中的 person_id 引用（relations.person_a、relations.person_b、persons.person_id）。rewrite SHALL 原子写入（临时文件 + rename）。

#### Scenario: rewrite ledger 中的临时 id
- **WHEN** ledger/chapter_001.json 中 relations 引用 ch1_p1 和 ch1_p2，映射表为 ch1_p1→p001, ch1_p2→p002
- **THEN** rewrite 后 ledger/chapter_001.json 中 relations 引用 p001 和 p002

### Requirement: 冲突写入 merge_queue
当两个不同 `canonical_name` 的人物存在别名重叠时，系统 SHALL 将冲突写入 `merge_queue.json`（不阻塞 status=analyzed）。merge_queue 格式为 `[{person_a_id, person_b_id, reason, aliases_overlap}]`。冲突检测逻辑 SHALL 通过调用公共函数 `detect_cast_conflicts(cast)` 实现，CastWriter 不再自行内联检测逻辑。

#### Scenario: 别名重叠写入 merge_queue
- **WHEN** ch1 propose "黛玉" aliases=["林妹妹"]，ch2 propose "林黛玉" aliases=["林妹妹"]
- **THEN** 两人分别分配 p001 和 p002，"林妹妹" 的重叠通过 detect_cast_conflicts 检测，写入 merge_queue.json：`[{person_a_id: "p001", person_b_id: "p002", reason: "alias_overlap", aliases_overlap: ["林妹妹"]}]`

#### Scenario: 冲突检测函数被复用
- **WHEN** CastWriter.finalize() 调用冲突检测
- **THEN** 实际调用 core/suspects.py 中的 detect_cast_conflicts 函数，而非 CastWriter 内联逻辑
