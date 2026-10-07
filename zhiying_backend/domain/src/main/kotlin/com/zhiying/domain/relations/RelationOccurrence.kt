package com.zhiying.domain.relations

import com.zhiying.domain.library.ChapterId
import com.zhiying.domain.library.EvidenceRef

/** 准入结果：按当前政策能否进入默认图。 */
sealed interface Admission {
    /** 满足准入，可以出图。 */
    data object Admitted : Admission

    /** 尚不满足；记录仍在内部保留，不伪装成已确认关系。 */
    data class Withheld(val reason: WithholdReason) : Admission
}

/** 未准入原因。 */
enum class WithholdReason {
    /** 语义未决。 */
    UNDETERMINED,

    /** 语义被否定。 */
    REFUTED,
}

/**
 * 章账本中的一条关系记录：两端已解析为书内人物，类型已归一，并关联当前有效的语义判断。
 *
 * 未决与否定的记录同样保留，用于追踪与后续判断，只是不准入。
 */
data class RelationOccurrence(
    val id: OccurrenceId,
    val key: RelationKey,
    val chapterId: ChapterId,
    val candidate: CandidateId,
    val evidence: List<EvidenceRef>,
    val assessment: RelationAssessment,
) {
    init {
        require(assessment.candidate == candidate) { "语义判断必须针对本记录的候选" }
        require(evidence.isNotEmpty()) { "关系记录至少要有一条依据" }
    }

    /**
     * 本期基础证据准入：语义有支持即可出图。
     * "章节 + 非空说明"已由 [EvidenceRef] 的构造约束与上面的非空校验保证，这里不再重复检查。
     */
    fun admission(): Admission = when (assessment.verdict) {
        SemanticVerdict.Supported -> Admission.Admitted
        is SemanticVerdict.Undetermined -> Admission.Withheld(WithholdReason.UNDETERMINED)
        SemanticVerdict.Refuted -> Admission.Withheld(WithholdReason.REFUTED)
    }

    /** 是否已准入。 */
    val admitted: Boolean get() = admission() == Admission.Admitted

    /**
     * 用定向补查的结论替换当前判断，返回新记录，不就地改写。
     * 只有未决记录可以补查；已成立或已否定的判断不再复核。
     */
    fun recheck(result: RelationAssessment): RelationOccurrence {
        require(assessment.verdict is SemanticVerdict.Undetermined) { "只有未决记录可以补查" }
        require(result.source == AssessmentSource.TARGETED_RECHECK) { "补查结论必须来自定向补查" }
        return copy(assessment = result)
    }
}
