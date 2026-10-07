// 关系记录构建：候选经身份映射和类型归一后生成带稳定 ID 的 RelationOccurrence；
// 无法构建的候选（端点未绑定、类型未归一、合并后自环）明确标出原因，不出图。
package com.zhiying.domain.relations

import com.zhiying.domain.identity.IdentityMap
import com.zhiying.domain.library.ChapterId

/** 候选未能构建成记录的原因。 */
enum class UnbuiltReason {
    /** 某个端点没有绑定到书内人物。 */
    UNBOUND_ENDPOINT,

    /** 类型没有归一。 */
    UNRESOLVED_TYPE,

    /** 两个端点经身份合并后落到同一人物，需要重新处理（常见于错误合并或候选本身有误），不能出图。 */
    SELF_LOOP,
}

/** 构建结果。 */
sealed interface BuildOutcome {
    /** 构建成功。 */
    data class Built(val occurrence: RelationOccurrence) : BuildOutcome

    /** 未能构建，附原因与说明；应用层据此重新处理或诊断，不会静默丢失。 */
    data class Unbuilt(val ref: CandidateRef, val reason: UnbuiltReason, val detail: String) : BuildOutcome
}

/**
 * 关系记录构建器：持有一份类型库与身份映射，所有端点都经同一份映射解析。
 */
class OccurrenceBuilder(
    private val library: RelationTypeLibrary,
    private val identities: IdentityMap,
) {
    /**
     * 构建一条关系记录。
     *
     * 入参：[chapter] 候选所在章；[candidate] 章内候选；[assessment] 其当前有效的语义判断；
     * [resolution] 类型归一结论（为空视为未归一）。
     * 出参：[BuildOutcome.Built] 或带原因的 [BuildOutcome.Unbuilt]。
     * 记录 ID 由章节与候选 ID 派生，重跑时保持稳定；准入结果由记录自身按判断给出。
     */
    fun build(
        chapter: ChapterId,
        candidate: RelationCandidate,
        assessment: RelationAssessment,
        resolution: TypeResolution?,
    ): BuildOutcome {
        val ref = CandidateRef(chapter, candidate.id)
        val source = identities.resolve(candidate.source)
        val target = identities.resolve(candidate.target)
        // 流程：端点解析 → 类型确认 → 按方向对应排出规范端点 → 生成规范键（自环返回 null）
        if (source == null || target == null) {
            return BuildOutcome.Unbuilt(ref, UnbuiltReason.UNBOUND_ENDPOINT, "端点未绑定到书内人物")
        }
        val resolved = resolution as? TypeResolution.Resolved
        val type = resolved?.let { library[it.type] }
        if (resolved == null || type == null) {
            val detail = (resolution as? TypeResolution.Unresolved)?.reason ?: "类型未归一"
            return BuildOutcome.Unbuilt(ref, UnbuiltReason.UNRESOLVED_TYPE, detail)
        }
        val (first, second) = resolved.orientation.apply(source, target)
        val key = type.keyFor(first, second)
            ?: return BuildOutcome.Unbuilt(ref, UnbuiltReason.SELF_LOOP, "两端合并后是同一人物: ${source.value}")
        val occurrence = RelationOccurrence(
            occurrenceIdOf(chapter, candidate.id), key, chapter, candidate.id, candidate.evidence, assessment,
        )
        return BuildOutcome.Built(occurrence)
    }

    companion object {
        /** 由章节与候选 ID 派生稳定的记录 ID。 */
        fun occurrenceIdOf(chapter: ChapterId, candidate: CandidateId) = OccurrenceId("occ:${chapter.value}:${candidate.value}")
    }
}
