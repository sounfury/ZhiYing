// 软兜底端口与兜底步骤：路人对走规则贴「相识」；重要对由模型查漏，疑似强关系补查一轮再入账，否则回落软标签。
package com.zhiying.application.analyze.relations

import com.zhiying.application.analyze.BatchLimits
import com.zhiying.application.analyze.boundedBatches
import com.zhiying.application.llm.ModelCallControl
import com.zhiying.domain.identity.Person
import com.zhiying.domain.identity.PersonId
import com.zhiying.domain.library.ChapterId
import com.zhiying.domain.relations.FallbackAcceptance
import com.zhiying.domain.relations.FallbackCase
import com.zhiying.domain.relations.Hardness
import com.zhiying.domain.relations.PersonPair
import com.zhiying.domain.relations.RelationOccurrence
import com.zhiying.domain.relations.RelationType
import com.zhiying.domain.relations.RelationTypeLibrary
import com.zhiying.domain.relations.ResolvedInteraction
import com.zhiying.domain.relations.SoftFallbackProposal
import com.zhiying.domain.relations.SoftFallbackRules
import com.zhiying.domain.relations.StrongUpgradeProposal
import com.zhiying.domain.relations.UpgradeAcceptance
import com.zhiying.domain.relations.UpgradeOutcome
import com.zhiying.domain.relations.coreOf

/** 一个待查兜底的人物对，附人物资料；人物顺序与规范人物对一致。 */
data class FallbackItem(val case: FallbackCase, val first: Person, val second: Person)

/**
 * 一批兜底请求。[softTypes] 是可选用的软类型（粗粒度，具体类型不得超出依据）；
 * 触发情形为"强候选被否定"时，[FallbackCase.refuted] 带有被否定的记录与理由，不能把被否定标签机械降级成软标签。
 * [strongTypes] 是重要对可以"疑似强关系"提出的硬 / 中类型。
 */
data class SoftFallbackRequest(
    val items: List<FallbackItem>,
    val softTypes: List<RelationType>,
    val control: ModelCallControl = ModelCallControl(),
    val strongTypes: List<RelationType> = emptyList(),
)

/** 单个人物对的兜底结果。 */
sealed interface FallbackResult {
    /** 对应的人物对。 */
    val pair: PersonPair

    /** 找到有依据的软兜底。 */
    data class Found(val proposal: SoftFallbackProposal) : FallbackResult {
        override val pair: PersonPair get() = proposal.pair
    }

    /**
     * 重要对的"疑似强关系"：模型认为这是漏掉的硬 / 中关系，不贴软标签；[soft] 是同时给出的软标签备选，
     * 补查被否定时直接回落，避免再调一次模型。
     */
    data class UpgradeStrong(val upgrade: StrongUpgradeProposal, val soft: SoftFallbackProposal?) : FallbackResult {
        override val pair: PersonPair get() = upgrade.pair
    }

    /** 找不到有依据的兜底：不连边。 */
    data class NotFound(override val pair: PersonPair, val reason: String) : FallbackResult

    /** 执行未完成（超时、取消、预算耗尽）：当作没有兜底，不影响其他人物对。 */
    data class NotCompleted(override val pair: PersonPair, val failure: String) : FallbackResult
}

/**
 * 软兜底端口（结构化输出）。
 *
 * 契约：只在该对的交流观察与上下文中找依据；选用的类型必须来自 [SoftFallbackRequest.softTypes]；
 * 标签须与依据相符，不能从一次交流直接推成"朋友"，也不能把一次告别之类的情节直接命名为关系；
 * 找不到有依据的兜底时返回 [FallbackResult.NotFound]。
 */
interface SoftFallbackFinder {
    /** 为一批人物对寻找软兜底；缺失的人物对视为未完成。 */
    fun find(request: SoftFallbackRequest): List<FallbackResult>
}

/**
 * 兜底统计。[planned] 为规划出的人物对数（含规则贴标）；[ruleLabeled] 路人对规则贴「相识」数；
 * [upgraded] 模型提出且通过校验、送去补查的疑似强关系人物对数；[upgradeEstablished] 其中补查成立的人物对数。
 * [accepted] 含规则以外所有收下的软兜底（含升级被否定后回落的）。
 */
data class FallbackStats(
    val planned: Int,
    val accepted: Int,
    val notFound: Int,
    val rejected: Int,
    val notCompleted: Int,
    val ruleLabeled: Int = 0,
    val upgraded: Int = 0,
    val upgradeEstablished: Int = 0,
)

/** 兜底步骤产物：新增的记录（软关系、升级成立的强关系，以及内部保留的未决 / 否定强候选）与统计。 */
data class FallbackOutcome(val added: List<RelationOccurrence>, val stats: FallbackStats)

/**
 * 软兜底步骤（应用层编排，非 Spring Bean）。
 *
 * 顺序：领域规划并分流（只在补查完成后调用，保证"未决先等"）→ 路人对由规则直接贴「相识」（无模型调用）→
 * 其余分批调用 [SoftFallbackFinder]（副作用：模型调用）→ 软标签由领域校验收下；"疑似强关系"由领域校验后
 * 生成强候选，经 [recheckStep] 补查一轮（副作用：读原文、模型调用）→ 领域按补查结果结算（成立入账 / 未决保留 / 否定回落）。
 * 不循环：升级只补查一次。
 */
class SoftFallbackStep(
    private val finder: SoftFallbackFinder,
    private val recheckStep: RelationRecheckStep,
    private val limits: BatchLimits = BatchLimits(maxItems = 6, maxChars = 12_000),
    private val control: ModelCallControl = ModelCallControl(),
    private val coreMinAppearance: Int = 2,
) {
    /** 一个等待补查的升级：人物对情形、补查前的强候选、模型同时给出的软标签备选。 */
    private class PendingUpgrade(val case: FallbackCase, val candidates: List<RelationOccurrence>, val soft: SoftFallbackProposal?)

    /**
     * 执行兜底。
     * 入参：[occurrences] 补查后的本轮记录加上保留的历史软关系；[interactions] 已解析的交流观察；
     * [appearances] 对齐后每个人物的出场章，用于区分重要人物与路人（阈值 `zhiying.post-process.core-min-appearance`）。
     * 出参：新增的记录；没有兜底的人物对不连边，被否定的强关系记录由调用方原样保留。
     */
    fun run(
        library: RelationTypeLibrary,
        occurrences: List<RelationOccurrence>,
        interactions: List<ResolvedInteraction>,
        persons: Map<PersonId, Person>,
        appearances: Map<PersonId, Set<ChapterId>>,
    ): FallbackOutcome {
        val rules = SoftFallbackRules(library, coreOf(appearances, coreMinAppearance))
        val plan = rules.plan(occurrences, interactions)
        val run = RunState(plan.byRule.flatMapTo(mutableListOf()) { rules.labelByRule(it) })
        val request = { batch: List<FallbackCase> ->
            SoftFallbackRequest(
                batch.map { FallbackItem(it, persons.getValue(it.pair.first), persons.getValue(it.pair.second)) },
                library.types.filter { it.hardness == Hardness.SOFT },
                control,
                library.types.filter { it.hardness.strong },
            )
        }
        for (batch in boundedBatches(plan.byModel, limits) { c -> c.interactions.sumOf { it.description.length } }) {
            val results = finder.find(request(batch)).associateBy { it.pair }
            for (case in batch) absorb(rules, case, results[case.pair], run)
        }
        settleUpgrades(rules, library, persons, run)
        val stats = FallbackStats(
            plan.byRule.size + plan.byModel.size, run.tally[0], run.tally[1], run.tally[2], run.tally[3],
            plan.byRule.size, run.pending.size, run.established,
        )
        return FallbackOutcome(run.added, stats)
    }

    /** 一次兜底过程的可变状态：新增记录、统计（收下、没找到、被拒绝、未完成）、待补查的升级、升级成立数。 */
    private class RunState(val added: MutableList<RelationOccurrence>) {
        val tally = IntArray(4)
        val pending = mutableListOf<PendingUpgrade>()
        var established = 0
    }

    /** 处理模型对一个人物对的结果：软标签直接校验收下，疑似强关系校验后排入补查。 */
    private fun absorb(rules: SoftFallbackRules, case: FallbackCase, result: FallbackResult?, run: RunState) {
        when (result) {
            is FallbackResult.Found -> acceptSoft(rules, case, result.proposal, run)
            is FallbackResult.UpgradeStrong -> when (val upgrade = rules.proposeUpgrade(case, result.upgrade)) {
                is UpgradeAcceptance.Candidates -> run.pending += PendingUpgrade(case, upgrade.occurrences, result.soft)
                is UpgradeAcceptance.Rejected -> result.soft?.let { acceptSoft(rules, case, it, run) } ?: run.tally[2]++
            }
            is FallbackResult.NotFound -> run.tally[1]++
            else -> run.tally[3]++
        }
    }

    /** 把待升级的强候选补查一轮，再由领域结算：成立入账、未决保留、否定回落。 */
    private fun settleUpgrades(rules: SoftFallbackRules, library: RelationTypeLibrary, persons: Map<PersonId, Person>, run: RunState) {
        if (run.pending.isEmpty()) return
        val rechecked = recheckStep.run(run.pending.flatMap { it.candidates }, library, persons).occurrences.associateBy { it.id }
        for (upgrade in run.pending) {
            val settled = rules.settleUpgrade(upgrade.case, upgrade.candidates.map { rechecked.getValue(it.id) }, upgrade.soft)
            run.added += settled.records
            when (settled.outcome) {
                UpgradeOutcome.ESTABLISHED -> run.established++
                UpgradeOutcome.FELL_BACK -> run.tally[0]++
                UpgradeOutcome.DROPPED -> run.tally[1]++
                UpgradeOutcome.UNDECIDED -> Unit
            }
        }
    }

    /** 校验并收下一条软标签兜底，累计到记录与统计。 */
    private fun acceptSoft(rules: SoftFallbackRules, case: FallbackCase, proposal: SoftFallbackProposal, run: RunState) {
        when (val accepted = rules.accept(case, proposal)) {
            is FallbackAcceptance.Accepted -> { run.added += accepted.occurrences; run.tally[0]++ }
            is FallbackAcceptance.Rejected -> run.tally[2]++
        }
    }
}
