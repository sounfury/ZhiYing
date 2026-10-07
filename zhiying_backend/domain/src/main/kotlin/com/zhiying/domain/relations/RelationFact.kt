package com.zhiying.domain.relations

import com.zhiying.domain.library.ChapterId
import com.zhiying.domain.library.EvidenceRef

/**
 * 出图用的关系事实：同一规范键下全部准入记录的汇总。
 *
 * 同一对人物可以同时有多条不同类型的事实（如师徒与夫妻），互不吞并；展示分数只用于排序，
 * 不参与决定事实是否成立。
 */
data class RelationFact(
    val key: RelationKey,
    val occurrences: List<RelationOccurrence>,
) {
    init {
        require(occurrences.isNotEmpty()) { "关系事实至少包含一条记录" }
        require(occurrences.all { it.key == key && it.admitted }) { "关系事实只能由同键的准入记录组成" }
    }

    /** 出现过的章节，按记录顺序去重。 */
    val chapters: Set<ChapterId> get() = occurrences.mapTo(linkedSetOf()) { it.chapterId }

    /** 全部依据，各条独立保留。 */
    val evidence: List<EvidenceRef> get() = occurrences.flatMap { it.evidence }

    companion object {
        /** 把关系记录汇总为关系事实；未决与否定的记录不参与。 */
        fun aggregate(occurrences: Iterable<RelationOccurrence>): List<RelationFact> =
            occurrences.filter { it.admitted }
                .groupBy { it.key }
                .map { (key, admitted) -> RelationFact(key, admitted) }
    }
}
