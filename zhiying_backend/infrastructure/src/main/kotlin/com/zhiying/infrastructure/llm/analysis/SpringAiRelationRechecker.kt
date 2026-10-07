// 定向补查的 Spring AI 实现：一批同原因的未决记录一次结构化调用，回复转成 RelationAssessment（来源 = 定向补查）。
package com.zhiying.infrastructure.llm.analysis

import com.zhiying.application.analyze.relations.RecheckItem
import com.zhiying.application.analyze.relations.RecheckRequest
import com.zhiying.application.analyze.relations.RecheckResult
import com.zhiying.application.analyze.relations.RelationRechecker
import com.zhiying.domain.relations.AssessmentSource
import com.zhiying.domain.relations.RelationAssessment
import com.zhiying.domain.relations.SemanticVerdict
import com.zhiying.domain.relations.UndeterminedReason
import com.zhiying.infrastructure.config.ZhiYingProperties
import com.zhiying.infrastructure.llm.StructuredCallExecutor
import com.zhiying.infrastructure.llm.StructuredOutcome
import com.zhiying.infrastructure.llm.ask
import org.slf4j.LoggerFactory
import org.springframework.stereotype.Component

/** 模型回复：每条记录一项结论。 */
internal data class RecheckReply(val results: List<RecheckResultDto> = emptyList())

/** 对一条记录的补查结论：verdict 为 supported / refuted / undetermined。 */
internal data class RecheckResultDto(
    val id: String = "",
    val verdict: String = "",
    val undeterminedReason: String? = null,
    val basis: String = "",
)

/**
 * 基于结构化调用的定向补查。
 *
 * 每条请求内的记录都有一个结果：通过程序校验的是 [RecheckResult.Assessed]，其余（调用失败、取消、预算耗尽、
 * 回复缺项、结论非法）一律是 [RecheckResult.NotCompleted]，记录保持未决，绝不伪造否定。
 * 补查结论里未决原因缺失 / 无法识别时沿用请求的原因。
 */
@Component
class SpringAiRelationRechecker(
    private val executor: StructuredCallExecutor,
    properties: ZhiYingProperties,
) : RelationRechecker {
    private val config = properties.postProcess
    private val log = LoggerFactory.getLogger(SpringAiRelationRechecker::class.java)

    /**
     * 对一批同原因的未决记录做补查。
     * 入参：[request] 原因、动作、记录材料与任务级控制。出参：与 [RecheckRequest.items] 一一对应的结果。
     */
    override fun recheck(request: RecheckRequest): List<RecheckResult> {
        val outcome = executor.ask<RecheckReply>(
            system = RecheckPrompts.SYSTEM,
            user = RecheckPrompts.user(request),
            model = AnalysisPromptText.modelOf(config.model),
            thinking = config.thinking,
            control = request.control,
        )
        if (outcome is StructuredOutcome.Failed) {
            log.warn("定向补查未完成（{}），{} 条记录保持未决：{}", outcome.failure, request.items.size, outcome.message)
            return request.items.map { RecheckResult.NotCompleted(it.occurrence.id, "${outcome.failure}: ${outcome.message}") }
        }
        val reply = (outcome as StructuredOutcome.Success).value
        val byId = reply.results.distinctBy { it.id }.associateBy { it.id }
        return request.items.mapIndexed { index, item -> resultFor(item, byId[RecheckPrompts.itemId(index)], request.reason) }
    }

    /** 单条记录的结果：回复缺项或结论非法时为未完成。 */
    private fun resultFor(item: RecheckItem, dto: RecheckResultDto?, requested: UndeterminedReason): RecheckResult {
        val id = item.occurrence.id
        if (dto == null) return RecheckResult.NotCompleted(id, "模型没有返回该记录的结论")
        val basis = dto.basis.trim()
        val verdict = when (dto.verdict.trim().lowercase()) {
            "supported" -> SemanticVerdict.Supported
            "refuted" -> SemanticVerdict.Refuted
            "undetermined" -> SemanticVerdict.Undetermined(AnalysisPromptText.parseReason(dto.undeterminedReason) ?: requested)
            else -> null
        }
        val problem = when {
            verdict == null -> "无法识别的结论「${dto.verdict}」"
            basis.isEmpty() -> "没有说明依据"
            else -> null
        }
        if (verdict == null || problem != null) {
            log.warn("丢弃补查结论 {}：{}", id.value, problem)
            return RecheckResult.NotCompleted(id, "补查结论无效：$problem")
        }
        val assessment = RelationAssessment(item.occurrence.candidate, verdict, basis, AssessmentSource.TARGETED_RECHECK)
        return RecheckResult.Assessed(id, assessment)
    }
}
