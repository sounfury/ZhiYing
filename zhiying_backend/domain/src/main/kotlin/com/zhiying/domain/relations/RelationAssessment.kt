package com.zhiying.domain.relations

/**
 * 语义结论：原文是否支持这条关系。
 *
 * 供应商超时、取消、预算耗尽属于执行结果，不在这里表达，更不能当作"原文无法证明"。
 */
sealed interface SemanticVerdict {
    /** 原文支持。 */
    data object Supported : SemanticVerdict

    /** 尚不能确定，附具体原因，决定后续补查方式。 */
    data class Undetermined(val reason: UndeterminedReason) : SemanticVerdict

    /** 原文明确否定，或正好相反。 */
    data object Refuted : SemanticVerdict
}

/** 未决原因：说明这次判断缺什么，而不是只有一个"待定"。 */
enum class UndeterminedReason {
    /** 指代或说话者不明：补相邻对话与相关提及。 */
    UNCLEAR_REFERENCE,

    /** 类型或方向含糊：附类型定义与双方角色重新判断。 */
    AMBIGUOUS_TYPE_OR_DIRECTION,

    /** 当前片段不足：扩充句子或段落上下文。 */
    INSUFFICIENT_CONTEXT,

    /** 比喻、尊称、传闻等无法确定：针对疑点补查，仍不足则保留未决。 */
    FIGURATIVE_OR_HEARSAY,
}

/** 语义判断的来源。 */
enum class AssessmentSource {
    /** 章 Agent 读章时的首次判断。 */
    CHAPTER_READING,

    /** 针对明确未决的硬 / 中关系做的有限补查。 */
    TARGETED_RECHECK,

    /** 强关系否定后，AI 依据实际交流生成软兜底时的判断。 */
    SOFT_FALLBACK,

    /** 两端都是路人时，由规则直接给出最粗软标签「相识」，不调用模型。 */
    RULE,
}

/** 对一条候选的一次语义判断及其依据。 */
data class RelationAssessment(
    val candidate: CandidateId,
    val verdict: SemanticVerdict,
    val basis: String,
    val source: AssessmentSource,
) {
    init {
        require(basis.isNotBlank()) { "语义判断必须说明依据" }
    }
}
