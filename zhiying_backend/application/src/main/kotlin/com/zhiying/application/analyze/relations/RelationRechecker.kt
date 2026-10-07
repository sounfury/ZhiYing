// 定向补查端口与补查步骤：只处理明确未决的硬 / 中关系，按未决原因分别打包，条数与请求次数有上限。
package com.zhiying.application.analyze.relations

import com.zhiying.application.analyze.BatchLimits
import com.zhiying.application.analyze.boundedBatches
import com.zhiying.application.llm.ModelCallControl
import com.zhiying.domain.identity.Person
import com.zhiying.domain.identity.PersonId
import com.zhiying.domain.library.ChapterId
import com.zhiying.domain.relations.AssessmentSource
import com.zhiying.domain.relations.OccurrenceId
import com.zhiying.domain.relations.RecheckAction
import com.zhiying.domain.relations.RecheckRules
import com.zhiying.domain.relations.RelationAssessment
import com.zhiying.domain.relations.RelationOccurrence
import com.zhiying.domain.relations.RelationType
import com.zhiying.domain.relations.RelationTypeLibrary
import com.zhiying.domain.relations.SemanticVerdict
import com.zhiying.domain.relations.UndeterminedReason

/** 一段为补查准备的原文上下文。 */
data class ContextExcerpt(val chapterId: ChapterId, val text: String)

/**
 * 补查上下文提供端口：应用在调用模型前为每条未决记录准备原文。
 * 从原句、相邻句、所在段落开始，按 [action] 决定如何有界扩展（对话边界处理指代，
 * 片段不足时再带有限的相关章节片段），不硬编码"前后各两句"。
 */
interface RecheckContextProvider {
    /** 为一条未决记录取补查所需的原文片段。 */
    fun contextFor(occurrence: RelationOccurrence, action: RecheckAction): List<ContextExcerpt>
}

/**
 * 一条待补查的记录及应用准备的材料：候选 ID（即记录自身）、具体疑问（[RelationOccurrence.assessment]
 * 中的未决原因）、首次判断及理由、类型与双方角色、人物与别名、来源章与原文上下文。
 * 人物顺序与记录规范键一致：[first] 承担类型的源角色。
 */
data class RecheckItem(
    val occurrence: RelationOccurrence,
    val type: RelationType,
    val first: Person,
    val second: Person,
    val context: List<ContextExcerpt>,
)

/** 一次补查请求：同一未决原因的一小批记录。 */
data class RecheckRequest(
    val reason: UndeterminedReason,
    val action: RecheckAction,
    val items: List<RecheckItem>,
    val control: ModelCallControl = ModelCallControl(),
)

/** 单条记录的补查结果。 */
sealed interface RecheckResult {
    /** 对应的记录。 */
    val occurrence: OccurrenceId

    /**
     * 完成补查：[assessment] 的来源必须是 [AssessmentSource.TARGETED_RECHECK]，候选为该记录的候选；
     * 结论可以是成立、否定或仍未决。
     */
    data class Assessed(override val occurrence: OccurrenceId, val assessment: RelationAssessment) : RecheckResult

    /** 执行未完成（超时、取消、预算耗尽、供应商失败）：记录保持未决，不等于被否定。 */
    data class NotCompleted(override val occurrence: OccurrenceId, val failure: String) : RecheckResult
}

/**
 * 定向补查端口（单项或有界小批的结构化输出）。
 * 不再复核补查结果；单项未决或失败不回滚其他判断。
 */
interface RelationRechecker {
    /** 对一批同原因的未决记录做补查；缺失的记录视为未完成。 */
    fun recheck(request: RecheckRequest): List<RecheckResult>
}

/** 补查上限：每次请求的条数与输入长度，以及整个分析最多发出的请求次数。具体数值实施时定。 */
data class RecheckBudget(
    val limits: BatchLimits = BatchLimits(maxItems = 5, maxChars = 12_000),
    val maxRequests: Int = 20,
)

/** 补查统计。 */
data class RecheckStats(
    val selected: Int,
    val supported: Int,
    val refuted: Int,
    val stillUndetermined: Int,
    val notCompleted: Int,
    val skippedByBudget: Int,
)

/** 补查步骤产物：更新后的全部记录（顺序不变）与统计。 */
data class RecheckOutcome(val occurrences: List<RelationOccurrence>, val stats: RecheckStats)

/**
 * 补查步骤（应用层编排，非 Spring Bean）。
 *
 * 顺序：领域选出明确未决的硬 / 中记录并按原因分组 → 准备原文上下文（副作用：读取）→
 * 分批调用 [RelationRechecker]（副作用：模型调用）→ 把补查结论替换进记录。
 * 超过预算的记录保持未决，内部保留，不当作否定。
 */
class RelationRecheckStep(
    private val rechecker: RelationRechecker,
    private val contexts: RecheckContextProvider,
    private val budget: RecheckBudget = RecheckBudget(),
    private val control: ModelCallControl = ModelCallControl(),
) {
    /** 对 [occurrences] 做有限补查；[persons] 用于为请求附带人物资料。 */
    fun run(
        occurrences: List<RelationOccurrence>,
        library: RelationTypeLibrary,
        persons: Map<PersonId, Person>,
    ): RecheckOutcome {
        val groups = RecheckRules.select(occurrences, library)
        val requests = groups.flatMap { (reason, records) ->
            boundedBatches(records, budget.limits) { it.evidence.sumOf { e -> e.note.length } + it.assessment.basis.length }
                .map { reason to it }
        }
        val sent = requests.take(budget.maxRequests)
        val current = occurrences.associateByTo(linkedMapOf()) { it.id }
        val counts = IntArray(4) // 成立、否定、仍未决、未完成
        for ((reason, records) in sent) {
            val action = RecheckRules.actionFor(reason)
            val items = records.map { toItem(it, action, library, persons) }
            val results = rechecker.recheck(RecheckRequest(reason, action, items, control)).associateBy { it.occurrence }
            for (record in records) {
                val result = results[record.id]
                val updated = (result as? RecheckResult.Assessed)?.takeIf { accepts(record, it.assessment) }
                    ?.let { record.recheck(it.assessment) }
                if (updated != null) current[record.id] = updated
                counts[outcomeIndex(updated)]++
            }
        }
        val skipped = requests.drop(budget.maxRequests).sumOf { it.second.size }
        val stats = RecheckStats(groups.values.sumOf { it.size }, counts[0], counts[1], counts[2], counts[3], skipped)
        return RecheckOutcome(current.values.toList(), stats)
    }

    /** 补查结论是否有效：针对本记录的候选，且来源是定向补查。 */
    private fun accepts(record: RelationOccurrence, assessment: RelationAssessment): Boolean =
        assessment.candidate == record.candidate && assessment.source == AssessmentSource.TARGETED_RECHECK

    /** 统计下标：0 成立，1 否定，2 仍未决，3 未完成或结论无效。 */
    private fun outcomeIndex(updated: RelationOccurrence?): Int = when (updated?.assessment?.verdict) {
        SemanticVerdict.Supported -> 0
        SemanticVerdict.Refuted -> 1
        is SemanticVerdict.Undetermined -> 2
        null -> 3
    }

    /** 为一条记录准备补查材料。 */
    private fun toItem(
        record: RelationOccurrence,
        action: RecheckAction,
        library: RelationTypeLibrary,
        persons: Map<PersonId, Person>,
    ) = RecheckItem(
        occurrence = record,
        type = library[record.key.type]!!,
        first = persons.getValue(record.key.first),
        second = persons.getValue(record.key.second),
        context = contexts.contextFor(record, action),
    )
}
