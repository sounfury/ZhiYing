// 身份歧义判断端口与对齐步骤：把各章提及对齐成全书人物，真正有歧义的部分交给针对性判断。
package com.zhiying.application.analyze.identity

import com.zhiying.application.analyze.BatchLimits
import com.zhiying.application.analyze.boundedBatches
import com.zhiying.application.llm.ModelCallControl
import com.zhiying.domain.extraction.ChapterExtraction
import com.zhiying.domain.identity.AlignedIdentities
import com.zhiying.domain.identity.DisambiguationAnswer
import com.zhiying.domain.identity.IdentityAlignment
import com.zhiying.domain.identity.IdentityAmbiguity
import com.zhiying.domain.identity.NameIndex
import com.zhiying.domain.identity.Person

/**
 * 一批身份歧义问题。每个问题已打包候选人物资料与各自的提及（含上下文指代），
 * 实现方可按需读取原文补充上下文。批量大小由调用方按上限控制；[control] 是任务级预算与取消。
 */
data class IdentityDisambiguationRequest(
    val ambiguities: List<IdentityAmbiguity>,
    val control: ModelCallControl = ModelCallControl(),
)

/**
 * 身份歧义判断端口（结构化输出，有界小批，不是自由翻书的 Agent）。
 *
 * 契约：
 * - 对每个问题（以候选组 [IdentityAmbiguity.candidates] 为键）返回一份 [DisambiguationAnswer]，
 *   其中可含多个同人组 / 不同人 / 未决结论，只能涉及该候选组内的人物；
 * - 信息不足时返回 [com.zhiying.domain.identity.IdentityDecision.Undecided] 或干脆不回答——保持独立；
 * - 超时、取消、预算耗尽等执行失败属于执行结果：对应问题不回答，不得伪造"不同人"的结论；
 * - 程序会校验回答（未知人物、重叠、自相矛盾），非法回答整体拒绝。
 */
interface IdentityDisambiguator {
    /** 判断一批歧义问题，返回已给出结论的问题的回答。 */
    fun disambiguate(request: IdentityDisambiguationRequest): List<DisambiguationAnswer>
}

/**
 * 身份对齐步骤（应用层编排，非 Spring Bean）。
 *
 * 顺序：领域对齐各章提及 → 把歧义问题分批交给 [IdentityDisambiguator]（副作用：模型调用）→
 * 回灌回答由领域校验并登记合并 → 产出人物、身份映射与出场章节。
 */
class IdentityAlignmentStep(
    private val disambiguator: IdentityDisambiguator,
    private val limits: BatchLimits = BatchLimits(maxItems = 8, maxChars = 12_000),
    private val control: ModelCallControl = ModelCallControl(),
    private val appellationLimit: Int = NameIndex.DEFAULT_APPELLATION_BRIDGE_LIMIT,
) {
    /**
     * 执行对齐。
     * 入参：[roster] 已有人名册；[extractions] 各章抽取，按阅读顺序排列。
     * 出参：对齐产物；没有回答的歧义保持独立，不阻断其他人物。
     */
    fun run(roster: List<Person>, extractions: List<ChapterExtraction>): AlignedIdentities {
        val draft = IdentityAlignment.start(roster, extractions, appellationLimit)
        val batches = boundedBatches(draft.ambiguities, limits, ::approximateSize)
        val answers = batches.flatMap { disambiguator.disambiguate(IdentityDisambiguationRequest(it, control)) }
        return draft.apply(answers).result()
    }

    /** 一个歧义问题的近似输入长度：人物资料与提及依据的字符数之和。 */
    private fun approximateSize(ambiguity: IdentityAmbiguity): Int =
        ambiguity.persons.sumOf { (it.profile?.length ?: 0) + it.names.sumOf(String::length) } +
            ambiguity.mentions.values.sumOf { list -> list.sumOf { it.basis.length + it.name.length } }
}
