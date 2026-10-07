// 补查规则：哪些记录进入有限的定向补查，以及按未决原因应如何准备补查材料（DESIGN §3.4）。
package com.zhiying.domain.relations

/** 针对未决原因的后续动作；应用层据此准备补查材料，不硬编码"前后各两句"。 */
enum class RecheckAction {
    /** 回到身份上下文，补相邻对话与相关提及。 */
    ENRICH_REFERENCE_CONTEXT,

    /** 附类型定义与双方角色，重新判断类型与方向。 */
    RESTATE_TYPE_AND_ROLES,

    /** 从原句扩充到相邻句、所在段落，必要时再带有限的相关章节片段。 */
    EXPAND_CONTEXT,

    /** 针对比喻、尊称、传闻等疑点补查；仍不足则保留未决。 */
    PROBE_DOUBT,
}

/** 补查规则：纯函数，不调用模型，也不关心预算（预算由应用层控制）。 */
object RecheckRules {

    /** 未决原因对应的补查动作。 */
    fun actionFor(reason: UndeterminedReason): RecheckAction = when (reason) {
        UndeterminedReason.UNCLEAR_REFERENCE -> RecheckAction.ENRICH_REFERENCE_CONTEXT
        UndeterminedReason.AMBIGUOUS_TYPE_OR_DIRECTION -> RecheckAction.RESTATE_TYPE_AND_ROLES
        UndeterminedReason.INSUFFICIENT_CONTEXT -> RecheckAction.EXPAND_CONTEXT
        UndeterminedReason.FIGURATIVE_OR_HEARSAY -> RecheckAction.PROBE_DOUBT
    }

    /** 记录是否需要补查：语义明确未决，且类型是硬 / 中关系。软关系未决不补查，也不影响出图。 */
    fun needsRecheck(occurrence: RelationOccurrence, library: RelationTypeLibrary): Boolean =
        occurrence.assessment.verdict is SemanticVerdict.Undetermined &&
            library[occurrence.key.type]?.hardness?.strong == true

    /**
     * 选出需要补查的记录，按未决原因分别打包；每组内硬关系排在中关系之前，同档保持原顺序。
     * 已成立、已否定的记录不复核；摘录不合法的问题在提交时已退回，不会出现在这里。
     */
    fun select(
        occurrences: List<RelationOccurrence>,
        library: RelationTypeLibrary,
    ): Map<UndeterminedReason, List<RelationOccurrence>> =
        occurrences.filter { needsRecheck(it, library) }
            .sortedBy { library[it.key.type]!!.hardness.ordinal }
            .groupBy { (it.assessment.verdict as SemanticVerdict.Undetermined).reason }
}
