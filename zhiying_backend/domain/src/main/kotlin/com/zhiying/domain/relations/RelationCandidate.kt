package com.zhiying.domain.relations

import com.zhiying.domain.identity.LocalPersonRef
import com.zhiying.domain.library.ChapterId
import com.zhiying.domain.library.EvidenceRef

/** 新类型建议：章 Agent 认为类型库中没有合适类型时，提交名称、定义、硬度与方向，供全书归一。 */
data class TypeProposal(
    val name: String,
    val definition: String,
    val hardness: Hardness,
    val direction: Direction,
) {
    init {
        require(name.isNotBlank()) { "新类型必须有名称" }
        require(definition.isNotBlank()) { "新类型必须有定义" }
    }
}

/** 候选引用的类型：类型库中的已知类型，或新类型建议。 */
sealed interface TypeReference {
    /** 类型库中的已知类型。 */
    data class Known(val id: RelationTypeId) : TypeReference

    /** 新类型建议，等待全书归一。 */
    data class Proposed(val proposal: TypeProposal) : TypeReference
}

/**
 * 章内一条明确关系候选：原始观察，不带"已确认"标志。
 *
 * 是否成立看 [RelationAssessment]，能否出图看准入。[source] 与 [target] 是观察到的顺序，
 * 有向关系的规范方向由类型归一决定。
 */
data class RelationCandidate(
    val id: CandidateId,
    val source: LocalPersonRef,
    val target: LocalPersonRef,
    val type: TypeReference,
    val description: String,
    val evidence: List<EvidenceRef>,
) {
    init {
        require(source != target) { "关系两端不能是同一人物" }
        require(source.chapterId == target.chapterId) { "候选两端必须属于同一章" }
        require(description.isNotBlank()) { "候选必须保留原文描述" }
        require(evidence.isNotEmpty()) { "候选至少要有一条依据" }
        require(evidence.all { it.chapterId == source.chapterId }) { "候选依据必须来自候选所在章" }
    }

    /** 候选所在章节。 */
    val chapterId: ChapterId get() = source.chapterId
}
