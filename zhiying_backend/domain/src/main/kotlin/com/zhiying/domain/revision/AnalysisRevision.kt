// 分析结果版本：一次分析产出的一整套彼此一致的人物、关系、类型与团体结果，是出图的唯一数据来源。
package com.zhiying.domain.revision

import com.zhiying.domain.affiliations.Affiliations
import com.zhiying.domain.identity.Person
import com.zhiying.domain.identity.PersonId
import com.zhiying.domain.library.BookId
import com.zhiying.domain.library.ChapterId
import com.zhiying.domain.library.EvidenceRef
import com.zhiying.domain.relations.RelationFact
import com.zhiying.domain.relations.RelationOccurrence
import com.zhiying.domain.relations.RelationTypeLibrary

/** 结果版本的身份。 */
@JvmInline
value class RevisionId(val value: String) {
    init {
        require(value.isNotBlank()) { "结果版本 ID 不能为空" }
    }
}

/**
 * 一套一致的分析结果：分析流水线构建、校验后整体发布，图查询只读取已发布的版本。
 *
 * 入参：[analyzedChapters] 本版本覆盖的章节；[persons] 合并后的书内人物（不含已被并入的人物）；
 * [types] 本书类型库；[occurrences] 章账本中的全部关系记录（含未决、否定记录，准入由记录自身判断）；
 * [affiliations] 团体与成员；[appearances] 每个人物出场的章节，用于按章计数过滤路人；
 * [chapterOrder] 章节的阅读序号（从 1 起，可选），出图时用来给章节编号和排列阶段，缺省时按章节 ID 排序。
 *
 * 建立时校验引用完整：关系、成员、出场只能引用本版本内的人物，关系类型必须在类型库中，章节必须在覆盖范围内。
 */
class AnalysisRevision(
    val id: RevisionId,
    val bookId: BookId,
    val analyzedChapters: Set<ChapterId>,
    val persons: List<Person>,
    val types: RelationTypeLibrary,
    val occurrences: List<RelationOccurrence>,
    val affiliations: Affiliations,
    val appearances: Map<PersonId, Set<ChapterId>>,
    val chapterOrder: Map<ChapterId, Int> = emptyMap(),
    val methodVersion: String? = null,
    val fullBook: Boolean = false,
) {
    /** 按 ID 索引的人物。 */
    val personsById: Map<PersonId, Person> = persons.associateBy { it.id }

    init {
        require(personsById.size == persons.size) { "人物 ID 重复" }
        requireReferencesKnown()
    }

    /** 只有当前方法成功发布的完整整书结果可复用；旧结果缺少标记时自然不命中。 */
    fun reusableFor(currentMethod: String): Boolean = fullBook && methodVersion == currentMethod

    fun withMethod(method: String, full: Boolean): AnalysisRevision = AnalysisRevision(
        id, bookId, analyzedChapters, persons, types, occurrences, affiliations, appearances, chapterOrder, method, full,
    )

    /** 分叉首次重跑的只读上下文：身份和类型不变，所有章节来源重定位到新书。 */
    fun remapChapters(targetBook: BookId, chapters: Map<ChapterId, ChapterId>): AnalysisRevision {
        fun evidence(ref: EvidenceRef): EvidenceRef = ref.copy(
            chapterId = chapters.getValue(ref.chapterId),
            quotes = ref.quotes.map { it.copy(chapterId = chapters.getValue(it.chapterId)) },
        )
        return AnalysisRevision(
            id = id,
            bookId = targetBook,
            analyzedChapters = analyzedChapters.mapTo(linkedSetOf()) { chapters.getValue(it) },
            persons = persons.map { person ->
                person.copy(bindings = person.bindings.map { it.copy(sourceChapter = chapters.getValue(it.sourceChapter)) })
            },
            types = types,
            occurrences = occurrences.map { it.copy(chapterId = chapters.getValue(it.chapterId), evidence = it.evidence.map(::evidence)) },
            affiliations = Affiliations(
                affiliations.groups.map { it.copy(nameSource = evidence(it.nameSource)) },
                affiliations.memberships.map { it.copy(evidence = evidence(it.evidence)) },
            ),
            appearances = appearances.mapValues { (_, appeared) -> appeared.mapTo(linkedSetOf()) { chapters.getValue(it) } },
            chapterOrder = chapterOrder.entries.associate { chapters.getValue(it.key) to it.value },
            methodVersion = methodVersion,
            fullBook = fullBook,
        )
    }

    /** 全部已准入记录汇总成的关系事实，同一对人物的多种类型各自独立。 */
    fun facts(): List<RelationFact> = RelationFact.aggregate(occurrences)

    /** 人物出场的章数（同一章多次提及只计一次）。 */
    fun appearanceCount(person: PersonId): Int = appearances[person]?.size ?: 0

    /** 校验关系、成员与出场引用的人物、类型、章节都在本版本之内。 */
    private fun requireReferencesKnown() {
        val unknownPersons = occurrences.flatMap { listOf(it.key.first, it.key.second) } +
            affiliations.memberships.map { it.person } + appearances.keys - personsById.keys
        require(unknownPersons.isEmpty()) { "引用了本版本之外的人物: ${unknownPersons.map { it.value }.distinct()}" }
        require(occurrences.all { types[it.key.type] != null }) { "关系记录引用了类型库之外的类型" }
        val chapters = occurrences.map { it.chapterId } + appearances.values.flatten()
        require(chapters.all { it in analyzedChapters }) { "引用了本版本覆盖范围之外的章节" }
    }
}
