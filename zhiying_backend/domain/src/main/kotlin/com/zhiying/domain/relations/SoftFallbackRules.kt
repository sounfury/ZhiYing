// 软关系兜底规则：判定哪些人物对需要兜底、谁走规则谁走模型、模型的"疑似强关系"如何变成待补查记录、补查后如何回落。
// 判定时机严格按 DESIGN §3.5 的表；模型只负责"找依据"，是否找、找到的能否收下由这里的规则决定。
package com.zhiying.domain.relations

import com.zhiying.domain.identity.PersonId
import com.zhiying.domain.library.ChapterId
import com.zhiying.domain.library.EvidenceRef

/** 无序人物对，规范顺序按 ID 排列，用作人物对级别规则的键。 */
@ConsistentCopyVisibility
data class PersonPair private constructor(val first: PersonId, val second: PersonId) {
    companion object {
        /** 由两个不同的人物生成规范人物对。 */
        fun of(a: PersonId, b: PersonId): PersonPair {
            require(a != b) { "人物对必须是两个不同的人物" }
            return if (a.value <= b.value) PersonPair(a, b) else PersonPair(b, a)
        }
    }
}

/** 交流观察已解析到书内人物后的形式。 */
data class ResolvedInteraction(val pair: PersonPair, val interaction: InteractionObservation)

/** 触发兜底查找的情形。 */
enum class FallbackTrigger {
    /** 没有任何硬 / 中候选，但有足够交流依据。 */
    NO_STRONG_CANDIDATE,

    /** 硬 / 中候选全部被否定，且没有其他成立的强关系：回看交流与上下文寻找兜底。 */
    STRONG_REFUTED,
}

/** 不查找兜底的原因（诊断用）。 */
enum class FallbackSkip {
    /** 已有成立的硬 / 中关系：不生成新软关系；历史软记录保留。 */
    HAS_SUPPORTED_STRONG,

    /** 有未决硬 / 中候选（含补查后仍未决、超时、预算耗尽）：先等后续判断，不抢先生成软关系，也不当作否定。 */
    STRONG_UNDETERMINED,

    /** 已有成立的软关系，无需再补。 */
    ALREADY_HAS_SOFT,

    /** 没有强候选也没有交流依据：同章共现不补边。 */
    NO_INTERACTION,
}

/** 一个人物对的判定结果。 */
sealed interface FallbackJudgement {
    /** 不查找。 */
    data class Skip(val reason: FallbackSkip) : FallbackJudgement

    /** 需要让模型寻找兜底。 */
    data class Search(val trigger: FallbackTrigger) : FallbackJudgement
}

/**
 * 一个待查找兜底的人物对：触发情形、被否定的强记录和该对的交流观察。
 * [important] 表示至少一端是重要人物（出场章数达到阈值）；重要对才允许模型提出"疑似强关系"。
 */
data class FallbackCase(
    val pair: PersonPair,
    val trigger: FallbackTrigger,
    val refuted: List<RelationOccurrence>,
    val interactions: List<InteractionObservation>,
    val important: Boolean = true,
)

/** 兜底规划结果：[byRule] 两端都是路人，直接贴「相识」不调模型；[byModel] 交给模型查漏再贴标。 */
data class FallbackPlan(val byRule: List<FallbackCase>, val byModel: List<FallbackCase>)

/**
 * 模型对重要人物对提出的"疑似强关系"：应是一条被漏掉的硬 / 中关系，而不是软标签。
 * [source] 是承担类型源角色的一端（无向类型时只用来固定人物对）；[evidence] 是依据，须带原文以便补查取证。
 */
data class StrongUpgradeProposal(
    val pair: PersonPair,
    val type: RelationTypeId,
    val source: PersonId,
    val basis: String,
    val evidence: List<EvidenceRef>,
) {
    init {
        require(basis.isNotBlank()) { "疑似强关系必须说明依据" }
        require(evidence.isNotEmpty()) { "疑似强关系至少要有一条依据" }
    }
}

/** 对疑似强关系的处置。 */
sealed interface UpgradeAcceptance {
    /** 收下为待补查的强候选记录（语义未决，来源为兜底），交给补查一轮。 */
    data class Candidates(val occurrences: List<RelationOccurrence>) : UpgradeAcceptance

    /** 拒绝，附原因；该对按普通软兜底处理。 */
    data class Rejected(val reason: String) : UpgradeAcceptance
}

/** 升级补查后的去向。 */
enum class UpgradeOutcome {
    /** 补查成立：入账为强关系，不再贴软标签。 */
    ESTABLISHED,

    /** 补查后未决或未完成：强候选内部保留，不连边，也不贴软标签。 */
    UNDECIDED,

    /** 补查否定，回落为模型同时给出的软标签备选。 */
    FELL_BACK,

    /** 补查否定且没有可用的软标签备选：不连边。 */
    DROPPED,
}

/** 升级结算：要写入结果的记录（含保留的未决 / 否定记录）与去向。 */
data class UpgradeSettlement(val records: List<RelationOccurrence>, val outcome: UpgradeOutcome)

/** 规则贴标与重要度划分用的常量。 */
object FallbackDefaults {
    /** 规则贴标使用的最粗软标签：相识。 */
    val ACQUAINTANCE = RelationTypeId("acquaintance_of")
}

/** 出场章数不少于 [minAppearance] 的人物是重要人物，其余是路人。 */
fun coreOf(appearances: Map<PersonId, Set<ChapterId>>, minAppearance: Int): Set<PersonId> =
    appearances.filterValues { it.size >= minAppearance }.keys

/** 模型找到的软兜底：选用的软类型与依据；只能引用类型库里的软类型，不新建类型。 */
data class SoftFallbackProposal(
    val pair: PersonPair,
    val type: RelationTypeId,
    val basis: String,
    val evidence: List<EvidenceRef>,
) {
    init {
        require(basis.isNotBlank()) { "兜底必须说明依据" }
        require(evidence.isNotEmpty()) { "兜底至少要有一条依据" }
    }
}

/** 对兜底结果的处置。 */
sealed interface FallbackAcceptance {
    /** 收下：按依据所在章生成的准入记录。 */
    data class Accepted(val occurrences: List<RelationOccurrence>) : FallbackAcceptance

    /** 拒绝，附原因；不连边，被否定的强关系记录照常保留。 */
    data class Rejected(val reason: String) : FallbackAcceptance
}

/**
 * 软兜底规则，基于一份类型库判断硬度。
 * [core] 是重要人物集合（见 [coreOf]）：两端都不在其中的人物对是"路人对"，兜底直接走规则，不调模型。
 */
class SoftFallbackRules(private val library: RelationTypeLibrary, private val core: Set<PersonId>) {

    /**
     * 判定一个人物对。入参为该对已有的关系记录（已含补查结果）和交流观察。
     *
     * 判定顺序即 DESIGN §3.5 的表：
     * 已有成立强关系 → 跳过；有未决强候选 → 等待；已有成立软关系 → 跳过；
     * 强候选全被否定 → 回看交流寻找兜底；无强候选时看有没有交流依据。
     */
    fun judge(occurrences: List<RelationOccurrence>, interactions: List<InteractionObservation>): FallbackJudgement {
        val (strong, soft) = occurrences.partition { library[it.key.type]?.hardness?.strong == true }
        return when {
            strong.any { it.admitted } -> FallbackJudgement.Skip(FallbackSkip.HAS_SUPPORTED_STRONG)
            strong.any { it.assessment.verdict is SemanticVerdict.Undetermined } ->
                FallbackJudgement.Skip(FallbackSkip.STRONG_UNDETERMINED)
            soft.any { it.admitted } -> FallbackJudgement.Skip(FallbackSkip.ALREADY_HAS_SOFT)
            strong.isNotEmpty() -> FallbackJudgement.Search(FallbackTrigger.STRONG_REFUTED)
            interactions.isEmpty() -> FallbackJudgement.Skip(FallbackSkip.NO_INTERACTION)
            else -> FallbackJudgement.Search(FallbackTrigger.NO_STRONG_CANDIDATE)
        }
    }


    /**
     * 规划全书需要查找兜底的人物对，并分流。
     *
     * 入参：[occurrences] 本轮构建并补查后的全部关系记录，加上上一版保留下来的历史软关系
     * （历史软关系参与判定，保证"历史已有"指之前已入账的记录，不受并行章节先后影响）；
     * [interactions] 已解析到人物的交流观察。
     * 出参：[FallbackPlan]，顺序稳定。两端都是路人且有交流依据的走规则（[labelByRule]），其余交给模型。
     */
    fun plan(occurrences: List<RelationOccurrence>, interactions: List<ResolvedInteraction>): FallbackPlan {
        val byPair = occurrences.groupBy { PersonPair.of(it.key.first, it.key.second) }
        val interactionsByPair = interactions.groupBy({ it.pair }, { it.interaction })
        val pairs = (byPair.keys + interactionsByPair.keys)
            .sortedWith(compareBy({ it.first.value }, { it.second.value }))
        val cases = pairs.mapNotNull { pair ->
            val records = byPair[pair].orEmpty()
            val talks = interactionsByPair[pair].orEmpty()
            (judge(records, talks) as? FallbackJudgement.Search)?.let { search ->
                val important = pair.first in core || pair.second in core
                FallbackCase(pair, search.trigger, records.filter { it.assessment.verdict == SemanticVerdict.Refuted }, talks, important)
            }
        }
        val (byRule, byModel) = cases.partition { !it.important && it.interactions.isNotEmpty() && library[FallbackDefaults.ACQUAINTANCE] != null }
        return FallbackPlan(byRule, byModel)
    }

    /**
     * 路人对的规则贴标：不调模型，直接生成最粗软标签「相识」，来源为交流观察，判断来源标明是规则。
     * 每章一条记录，依据取该章的交流观察，满足基础准入（章节 + 说明）。
     */
    fun labelByRule(case: FallbackCase): List<RelationOccurrence> {
        val type = checkNotNull(library[FallbackDefaults.ACQUAINTANCE]) { "类型库缺少「相识」" }
        return recordsOf(case.pair, type, case.interactions.map { it.evidence }, "两端均为路人，且正文中有实际交流（规则贴标，不调用模型）", AssessmentSource.RULE, "rule", SemanticVerdict.Supported)
    }

    /**
     * 校验并收下模型找到的软兜底。
     *
     * 规则：必须针对该情形的人物对；类型必须在库中且是无向的软类型（粗粒度，不能用硬 / 中类型兜底）；
     * 依据按章拆成记录，每条记录都带"首次准入来源 = 软兜底"的支持结论，满足基础证据准入即可出图。
     */
    fun accept(case: FallbackCase, proposal: SoftFallbackProposal): FallbackAcceptance {
        val type = library[proposal.type]
        val reason = when {
            proposal.pair != case.pair -> "兜底针对的人物对与请求不一致"
            type == null -> "兜底使用了类型库之外的类型"
            type.hardness != Hardness.SOFT -> "兜底只能使用软类型"
            type.direction != Direction.Undirected -> "兜底只能使用无向类型"
            else -> null
        }
        if (reason != null || type == null) return FallbackAcceptance.Rejected(reason ?: "兜底类型无效")
        val records = recordsOf(case.pair, type, proposal.evidence, proposal.basis, AssessmentSource.SOFT_FALLBACK, "fallback", SemanticVerdict.Supported)
        return FallbackAcceptance.Accepted(records)
    }

    /**
     * 校验并收下模型的"疑似强关系"，生成待补查的强候选。
     *
     * 规则：只有重要对可以升级；针对该情形的人物对；类型在库中且是硬 / 中类型；源端属于该人物对；
     * 不得重复提出该对已被否定的类型（否定就是否定，不循环）。候选语义为未决，由补查一轮定夺。
     */
    fun proposeUpgrade(case: FallbackCase, proposal: StrongUpgradeProposal): UpgradeAcceptance {
        val type = library[proposal.type]
        val reason = when {
            !case.important -> "路人对不升级为强关系"
            proposal.pair != case.pair -> "疑似强关系针对的人物对与请求不一致"
            type == null -> "疑似强关系使用了类型库之外的类型"
            !type.hardness.strong -> "疑似强关系必须是硬 / 中类型"
            proposal.source != case.pair.first && proposal.source != case.pair.second -> "源端不属于该人物对"
            case.refuted.any { it.key.type == type.id } -> "该类型已被否定，不能原样再提"
            else -> null
        }
        if (reason != null || type == null) return UpgradeAcceptance.Rejected(reason ?: "疑似强关系无效")
        val other = if (proposal.source == case.pair.first) case.pair.second else case.pair.first
        val pending = SemanticVerdict.Undetermined(UndeterminedReason.INSUFFICIENT_CONTEXT)
        val records = recordsOf(case.pair, type, proposal.evidence, proposal.basis, AssessmentSource.SOFT_FALLBACK, "upgrade", pending, type.keyFor(proposal.source, other)!!)
        return UpgradeAcceptance.Candidates(records)
    }

    /**
     * 补查一轮后结算升级：任一条成立 → 入账强关系；否则有未决（含未完成）→ 内部保留不连边；
     * 全部否定 → 回落为模型给出的软标签备选（经 [accept] 校验），没有备选则不连边。不再循环。
     * 入参：[rechecked] 补查后的候选记录；[soft] 模型同时给出的软标签备选。
     */
    fun settleUpgrade(case: FallbackCase, rechecked: List<RelationOccurrence>, soft: SoftFallbackProposal?): UpgradeSettlement {
        if (rechecked.any { it.admitted }) return UpgradeSettlement(rechecked, UpgradeOutcome.ESTABLISHED)
        if (rechecked.any { it.assessment.verdict is SemanticVerdict.Undetermined }) return UpgradeSettlement(rechecked, UpgradeOutcome.UNDECIDED)
        val fallback = soft?.let { accept(case, it) } as? FallbackAcceptance.Accepted
            ?: return UpgradeSettlement(rechecked, UpgradeOutcome.DROPPED)
        return UpgradeSettlement(rechecked + fallback.occurrences, UpgradeOutcome.FELL_BACK)
    }

    /** 依据按章拆成记录；[verdict] 是记录的初始语义结论，[key] 缺省时按类型规范方向取人物对。 */
    private fun recordsOf(
        pair: PersonPair,
        type: RelationType,
        evidence: List<EvidenceRef>,
        basis: String,
        source: AssessmentSource,
        prefix: String,
        verdict: SemanticVerdict,
        key: RelationKey = type.keyFor(pair.first, pair.second)!!,
    ): List<RelationOccurrence> = evidence.groupBy { it.chapterId }.map { (chapter, items) ->
        val tag = "${pair.first.value}~${pair.second.value}:${type.id.value}:${chapter.value}"
        val candidate = CandidateId("$prefix:$tag")
        RelationOccurrence(OccurrenceId("$prefix:$tag"), key, chapter, candidate, items.distinctBy { it.id }, RelationAssessment(candidate, verdict, basis, source))
    }
}
