## MODIFIED Requirements

### Requirement: 冲突写入 merge_queue
当两个不同 `canonical_name` 的人物存在别名重叠时，系统 SHALL 将冲突写入 `merge_queue.json`（不阻塞 status=analyzed）。merge_queue 格式为 `[{person_a_id, person_b_id, reason, aliases_overlap}]`。冲突检测逻辑 SHALL 通过调用公共函数 `detect_cast_conflicts(cast)` 实现，CastWriter 不再自行内联检测逻辑。

#### Scenario: 别名重叠写入 merge_queue
- **WHEN** ch1 propose "黛玉" aliases=["林妹妹"]，ch2 propose "林黛玉" aliases=["林妹妹"]
- **THEN** 两人分别分配 p001 和 p002，"林妹妹" 的重叠通过 detect_cast_conflicts 检测，写入 merge_queue.json：`[{person_a_id: "p001", person_b_id: "p002", reason: "alias_overlap", aliases_overlap: ["林妹妹"]}]`

#### Scenario: 冲突检测函数被复用
- **WHEN** CastWriter.finalize() 调用冲突检测
- **THEN** 实际调用 core/suspects.py 中的 detect_cast_conflicts 函数，而非 CastWriter 内联逻辑