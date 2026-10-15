// 身份歧义判断的 Spring AI 实现：一批问题一次结构化调用，回复转成领域结论；采纳的结论与依据、丢弃的非法项都记日志。
package com.zhiying.infrastructure.llm.analysis

import com.zhiying.application.analyze.identity.IdentityDisambiguationRequest
import com.zhiying.application.analyze.identity.IdentityDisambiguator
import com.zhiying.domain.identity.DecisionSource
import com.zhiying.domain.identity.DisambiguationAnswer
import com.zhiying.domain.identity.IdentityAmbiguity
import com.zhiying.domain.identity.IdentityDecision
import com.zhiying.domain.identity.PersonId
import com.zhiying.domain.library.ChapterId
import com.zhiying.infrastructure.config.ZhiYingProperties
import com.zhiying.infrastructure.llm.StructuredCallExecutor
import com.zhiying.infrastructure.llm.StructuredOutcome
import org.slf4j.LoggerFactory
import org.springframework.stereotype.Component

/** 模型回复：每个问题一项回答。 */
internal data class IdentityReply(val answers: List<IdentityAnswerDto> = emptyList())

/** 对一个问题的回答，question 为问题编号。 */
internal data class IdentityAnswerDto(val question: String = "", val decisions: List<IdentityDecisionDto> = emptyList())

/** 一个身份结论：verdict 为 same / distinct / undecided。 */
internal data class IdentityDecisionDto(
    val verdict: String = "",
    val persons: List<String> = emptyList(),
    val basis: String = "",
)

/**
 * 基于结构化调用的身份歧义判断。
 *
 * 执行失败（取消、预算耗尽、供应商失败、回复无法解析）时返回空列表：对应问题没有回答，各人物保持独立，
 * 绝不伪造"不同人"的结论。程序侧丢弃的非法项：未知问题编号、候选组外的人物、不足两人或没有依据的结论、
 * 重叠或自相矛盾的整份回答。
 */
@Component
class SpringAiIdentityDisambiguator(
    private val executor: StructuredCallExecutor,
    properties: ZhiYingProperties,
) : IdentityDisambiguator {
    private val config = properties.postProcess
    private val log = LoggerFactory.getLogger(SpringAiIdentityDisambiguator::class.java)

    /**
     * 判断一批歧义问题。
     * 入参：[request] 问题与任务级控制。出参：通过程序校验的回答；失败时为空。
     */
    override fun disambiguate(request: IdentityDisambiguationRequest): List<DisambiguationAnswer> {
        val outcome = executor.askPostProcess<IdentityReply>(
            system = IdentityPrompts.SYSTEM,
            user = IdentityPrompts.user(request.ambiguities, config.mentionsPerPerson, request.chapterOrder),
            control = request.control,
            config = config,
        )
        return when (outcome) {
            is StructuredOutcome.Failed -> {
                log.warn("身份歧义判断未完成（{}），{} 个问题保持独立：{}", outcome.failure, request.ambiguities.size, outcome.message)
                emptyList()
            }
            is StructuredOutcome.Success -> convert(outcome.value, request.ambiguities, request.chapterOrder)
        }
    }

    /** 回复转领域回答：按问题编号对应，逐项校验，非法项记日志丢弃，采纳的结论连同依据记日志备查。 */
    private fun convert(
        reply: IdentityReply,
        ambiguities: List<IdentityAmbiguity>,
        chapterOrder: Map<ChapterId, Int>,
    ): List<DisambiguationAnswer> {
        val byId = ambiguities.withIndex().associate { IdentityPrompts.questionId(it.index) to it.value }
        val answers = mutableListOf<DisambiguationAnswer>()
        for (dto in reply.answers.distinctBy { it.question }) {
            val ambiguity = byId[dto.question]
            if (ambiguity == null) {
                log.warn("丢弃回答：未知问题编号 {}", dto.question)
                continue
            }
            val decisions = dto.decisions.mapNotNull { toDecision(it, ambiguity) }
            if (decisions.isEmpty()) continue
            val problem = ambiguity.validate(decisions)
            if (problem != null) {
                log.warn("丢弃问题 {} 的整份回答：{}", dto.question, problem)
                continue
            }
            decisions.forEach { log.info("身份结论 {}：{}", verdictOf(it), describe(it, ambiguity, chapterOrder)) }
            answers += DisambiguationAnswer(ambiguity.candidates, decisions)
        }
        val answered = answers.map { it.candidates }.toSet()
        ambiguities.filter { it.candidates !in answered }.forEach { unanswered ->
            log.info("身份问题没有可用回答，候选人物保持独立：{}", unanswered.persons.joinToString("、") { it.displayName })
        }
        return answers
    }

    /** 结论的文字说法。 */
    private fun verdictOf(decision: IdentityDecision): String = when (decision) {
        is IdentityDecision.SamePerson -> "same"
        is IdentityDecision.DistinctPersons -> "distinct"
        is IdentityDecision.Undecided -> "undecided"
    }

    /** 日志里的一条结论：涉及的人物（展示名与最早出现的章节）和依据。 */
    private fun describe(decision: IdentityDecision, ambiguity: IdentityAmbiguity, chapterOrder: Map<ChapterId, Int>): String {
        val people = ambiguity.persons.filter { it.id in decision.persons }.joinToString("、") {
            "${it.displayName}（${IdentityPrompts.chapterLabel(it.bindings.first().sourceChapter, chapterOrder)}）"
        }
        return "$people —— ${decision.basis}"
    }

    /** 单个结论转领域对象（人物按代号或完整 ID 解析）；人物不在候选组、不足两人、没有依据或结论词无法识别时返回 null。 */
    private fun toDecision(dto: IdentityDecisionDto, ambiguity: IdentityAmbiguity): IdentityDecision? {
        val refs = IdentityPrompts.refs(ambiguity)
        val persons = dto.persons.map { it.trim() }.filter { it.isNotEmpty() }
            .map { AnalysisPromptText.resolvePerson(it, refs) ?: PersonId(it) }.toSet()
        val problem = when {
            persons.size < 2 -> "涉及人物不足两个"
            !ambiguity.candidates.containsAll(persons) -> "涉及候选组之外的人物 ${(persons - ambiguity.candidates).map { it.value }}"
            dto.basis.isBlank() -> "没有说明依据"
            else -> null
        }
        if (problem != null) {
            log.warn("丢弃身份结论（{}）：{}", dto.verdict, problem)
            return null
        }
        val basis = dto.basis.trim()
        val source = DecisionSource.TARGETED_JUDGMENT
        return when (dto.verdict.trim().lowercase()) {
            "same" -> IdentityDecision.SamePerson(persons, basis, source)
            "distinct" -> IdentityDecision.DistinctPersons(persons, basis, source)
            "undecided" -> IdentityDecision.Undecided(persons, basis, source)
            else -> {
                log.warn("丢弃身份结论：无法识别的 verdict「{}」", dto.verdict)
                null
            }
        }
    }
}
