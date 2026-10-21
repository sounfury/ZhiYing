package com.zhiying.domain.relations

import com.zhiying.domain.library.ChapterId
import com.zhiying.domain.library.EvidenceRef

/**
 * 出图用的关系事实：同一规范键下全部准入记录的汇总。
 *
 * 同一对人物可以同时有多条不同类型的事实（如师徒与夫妻），互不吞并；唯一的例外是宽泛关系遇到对应的精确关系
 * （兄弟姐妹遇到手足（长幼）），宽泛那条的记录并入 [absorbed]，只贡献章节与依据。展示分数只用于排序，不参与决定事实是否成立。
 */
data class RelationFact(
    val key: RelationKey,
    val occurrences: List<RelationOccurrence>,
    val absorbed: List<RelationOccurrence> = emptyList(),
) {
    init {
        require(occurrences.isNotEmpty()) { "关系事实至少包含一条记录" }
        require(occurrences.all { it.key == key && it.admitted }) { "关系事实只能由同键的准入记录组成" }
    }

    /** 出现过的章节，按记录顺序去重。 */
    val chapters: Set<ChapterId> get() = (occurrences + absorbed).mapTo(linkedSetOf()) { it.chapterId }

    /** 全部依据，各条独立保留。 */
    val evidence: List<EvidenceRef> get() = (occurrences + absorbed).flatMap { it.evidence }

    /** 原文称谓，供措辞；并入的宽泛记录不参与。 */
    val terms: List<String?> get() = occurrences.map { it.term }

    companion object {
        /**
         * 把关系记录汇总为关系事实；未决与否定的记录不参与。
         * 同一对人物上，宽泛关系（[broaderOf] 指向它的精确关系存在时）并入第一条对应的精确关系，不再单独成事实。
         */
        fun aggregate(
            occurrences: Iterable<RelationOccurrence>,
            broaderOf: (RelationTypeId) -> RelationTypeId? = BuiltInRelationTypes::broaderOf,
        ): List<RelationFact> {
            val facts = occurrences.filter { it.admitted }.groupBy { it.key }.map { (key, admitted) -> RelationFact(key, admitted) }
            val pairOf = { f: RelationFact -> PersonPair.of(f.key.first, f.key.second) }
            val byPair = facts.groupBy(pairOf)
            val host = facts.associateWith { coarse -> byPair.getValue(pairOf(coarse)).firstOrNull { broaderOf(it.key.type) == coarse.key.type } }
            return facts.filter { host[it] == null }.map { fact ->
                val merged = byPair.getValue(pairOf(fact)).filter { host[it] == fact }.flatMap { it.occurrences }
                if (merged.isEmpty()) fact else fact.copy(absorbed = merged)
            }
        }
    }
}
