// 结果版本组装：把身份对齐、类型库与关系记录（含保留的历史软关系）组装成初始版本，团体由后续归纳补入。
package com.zhiying.domain.revision

import com.zhiying.domain.affiliations.Affiliations
import com.zhiying.domain.identity.AlignedIdentities
import com.zhiying.domain.library.BookId
import com.zhiying.domain.library.ChapterId
import com.zhiying.domain.relations.RelationOccurrence
import com.zhiying.domain.relations.RelationTypeLibrary

/** 组装规则（纯函数）。 */
object RevisionAssembly {

    /**
     * 组装结果版本。
     *
     * 入参：[identities] 身份对齐产物；[types] 本书类型库（含本次登记的新类型）；
     * [occurrences] 本轮构建的全部关系记录（含未决、否定）；
     * [retained] 已经 [carry] 重定位的历史软关系；
     * [chapterOrder] 章节阅读序号，只保留本版本覆盖的章节。
     * 出参：满足 [AnalysisRevision] 全部引用完整性约束的版本。同一记录 ID 以本轮构建的为准。
     */
    fun assemble(
        id: RevisionId,
        bookId: BookId,
        analyzedChapters: Set<ChapterId>,
        identities: AlignedIdentities,
        types: RelationTypeLibrary,
        occurrences: List<RelationOccurrence>,
        retained: List<RelationOccurrence> = emptyList(),
        chapterOrder: Map<ChapterId, Int> = emptyMap(),
    ): AnalysisRevision {
        val merged = (occurrences + retained).distinctBy { it.id }
        return AnalysisRevision(
            id = id,
            bookId = bookId,
            analyzedChapters = analyzedChapters,
            persons = identities.persons,
            types = types,
            occurrences = merged,
            affiliations = Affiliations(emptyList(), emptyList()),
            appearances = identities.appearances,
            chapterOrder = chapterOrder.filterKeys { it in analyzedChapters },
        )
    }

    /**
     * 把上一版保留的历史软关系按当前身份映射重定位；须在软兜底前调用，保证兜底与入账用同一组人物键。
     * [retained] 由调用方先按"来源章节仍然有效"筛过；合并后自环、端点或类型已不存在、章节不在 [analyzedChapters] 内的丢弃。
     */
    fun carry(
        retained: List<RelationOccurrence>,
        identities: AlignedIdentities,
        types: RelationTypeLibrary,
        analyzedChapters: Set<ChapterId>,
    ): List<RelationOccurrence> {
        val known = identities.persons.mapTo(mutableSetOf()) { it.id }
        return retained.mapNotNull { rekey(it, identities, types) }
            .filter { it.chapterId in analyzedChapters && it.key.first in known && it.key.second in known }
    }

    /** 按当前身份映射重新生成历史记录的规范键；类型已不在库中或两端合并成同一人时返回 null。 */
    private fun rekey(
        occurrence: RelationOccurrence,
        identities: AlignedIdentities,
        types: RelationTypeLibrary,
    ): RelationOccurrence? {
        val type = types[occurrence.key.type] ?: return null
        val first = identities.identityMap.canonical(occurrence.key.first)
        val second = identities.identityMap.canonical(occurrence.key.second)
        return type.keyFor(first, second)?.let { occurrence.copy(key = it) }
    }
}
