// 软关系兜底的 Spring AI 实现：一批人物对一次结构化调用，回复转成 SoftFallbackProposal；是否收下由领域规则再校验。
package com.zhiying.infrastructure.llm.analysis

import com.zhiying.application.analyze.relations.FallbackItem
import com.zhiying.application.analyze.relations.FallbackResult
import com.zhiying.application.analyze.relations.SoftFallbackFinder
import com.zhiying.application.analyze.relations.SoftFallbackRequest
import com.zhiying.domain.identity.PersonId
import com.zhiying.domain.library.EvidenceRef
import com.zhiying.domain.relations.Direction
import com.zhiying.domain.relations.RelationType
import com.zhiying.domain.relations.RelationTypeId
import com.zhiying.domain.relations.SoftFallbackProposal
import com.zhiying.domain.relations.StrongUpgradeProposal
import com.zhiying.infrastructure.config.ZhiYingProperties
import com.zhiying.infrastructure.llm.StructuredCallExecutor
import com.zhiying.infrastructure.llm.StructuredOutcome
import com.zhiying.infrastructure.llm.ask
import org.slf4j.LoggerFactory
import org.springframework.stereotype.Component

/** 模型回复：每个人物对一项结论。 */
internal data class FallbackReply(val results: List<FallbackResultDto> = emptyList())

/**
 * 对一个人物对的结论。
 * found=true 时 kind 为 soft（默认）：带软类型 typeId、依据 basis 与所用交流编号；
 * kind 为 strong（仅重要对）：疑似强关系，带 strongTypeId、strongSourceId（承担源角色的人物代号 P1 / P2，也接受完整 ID）、strongBasis 与交流编号，
 * 同时可选给出软标签备选（typeId + basis），补查被否定时直接回落。
 */
internal data class FallbackResultDto(
    val id: String = "",
    val found: Boolean = false,
    val kind: String = "soft",
    val typeId: String? = null,
    val basis: String = "",
    val interactions: List<String> = emptyList(),
    val strongTypeId: String? = null,
    val strongSourceId: String? = null,
    val strongBasis: String = "",
    val reason: String = "",
)

/**
 * 基于结构化调用的软兜底查找（含重要对的"疑似强关系"查漏）。
 *
 * 每个人物对都有一个结果：找到且通过程序校验的是 [FallbackResult.Found] 或 [FallbackResult.UpgradeStrong]；
 * 模型说找不到、或给出的兜底非法（类型不在可选列表、没有依据、引用了不存在的交流编号）是 [FallbackResult.NotFound]；
 * 疑似强关系不合法时，有合法的软标签备选就退回软兜底；调用失败、取消、预算耗尽、回复缺项是 [FallbackResult.NotCompleted]。
 */
@Component
class SpringAiSoftFallbackFinder(
    private val executor: StructuredCallExecutor,
    properties: ZhiYingProperties,
) : SoftFallbackFinder {
    private val config = properties.postProcess
    private val log = LoggerFactory.getLogger(SpringAiSoftFallbackFinder::class.java)

    /**
     * 为一批人物对寻找软兜底或疑似强关系。
     * 入参：[request] 人物对、可选软类型、可提的强类型与任务级控制。出参：与 [SoftFallbackRequest.items] 一一对应的结果。
     */
    override fun find(request: SoftFallbackRequest): List<FallbackResult> {
        // 兜底只能用无向软类型（领域规则同样要求），提示里也只列这些
        val softTypes = request.softTypes.filter { it.direction == Direction.Undirected }
        val outcome = executor.ask<FallbackReply>(
            system = FallbackPrompts.SYSTEM,
            user = FallbackPrompts.user(softTypes, request.strongTypes, request.items, config.fallbackInteractionsPerPair),
            model = AnalysisPromptText.modelOf(config.model),
            thinking = config.thinking,
            control = request.control,
        )
        if (outcome is StructuredOutcome.Failed) {
            log.warn("软兜底未完成（{}），{} 个人物对不连边：{}", outcome.failure, request.items.size, outcome.message)
            return request.items.map { FallbackResult.NotCompleted(it.case.pair, "${outcome.failure}: ${outcome.message}") }
        }
        val byId = (outcome as StructuredOutcome.Success).value.results.distinctBy { it.id }.associateBy { it.id }
        val allowed = softTypes.associateBy { it.id }
        val strong = request.strongTypes.associateBy { it.id }
        return request.items.mapIndexed { index, item -> resultFor(item, byId[FallbackPrompts.pairId(index)], allowed, strong) }
    }

    /** 单个人物对的结果：缺项为未完成，非法为没找到；疑似强关系非法时退回合法的软标签备选。 */
    private fun resultFor(
        item: FallbackItem,
        dto: FallbackResultDto?,
        allowed: Map<RelationTypeId, RelationType>,
        strong: Map<RelationTypeId, RelationType>,
    ): FallbackResult {
        val pair = item.case.pair
        if (dto == null) return FallbackResult.NotCompleted(pair, "模型没有返回该人物对的结论")
        if (!dto.found) return FallbackResult.NotFound(pair, dto.reason.trim().ifBlank { "模型未找到有依据的兜底" })
        val shown = item.case.interactions.take(config.fallbackInteractionsPerPair)
        val refs = dto.interactions.map { it.trim() }.distinct()
        val evidence = refs.mapNotNull { ref -> shown.withIndex().firstOrNull { FallbackPrompts.interactionId(it.index) == ref }?.value?.evidence }
        val evidenceProblem = if (evidence.isEmpty() || evidence.size != refs.size) "引用了不存在的交流编号 ${dto.interactions}" else null
        val typeId = dto.typeId?.trim().orEmpty()
        val softProblem = when {
            typeId.isEmpty() || allowed[RelationTypeId(typeId)] == null -> "类型「$typeId」不在可选软类型之中"
            dto.basis.isBlank() -> "没有说明依据"
            else -> evidenceProblem
        }
        val soft = if (softProblem == null) {
            SoftFallbackProposal(pair, RelationTypeId(typeId), dto.basis.trim(), evidence.distinctBy { it.id })
        } else {
            null
        }
        if (dto.kind.trim().lowercase() == "strong") {
            val upgrade = upgradeOf(item, dto, strong, evidence, evidenceProblem)
            if (upgrade.first != null) return FallbackResult.UpgradeStrong(upgrade.first!!, soft)
            log.warn("丢弃疑似强关系 {}：{}", pair, upgrade.second)
        }
        if (soft == null) {
            log.warn("丢弃兜底结论 {}：{}", pair, softProblem)
            return FallbackResult.NotFound(pair, "模型给出的兜底无效：$softProblem")
        }
        return FallbackResult.Found(soft)
    }

    /** 校验疑似强关系字段，返回提案或失败原因；是否允许升级（重要对）与否定类型的限制由领域规则再校验。 */
    private fun upgradeOf(
        item: FallbackItem,
        dto: FallbackResultDto,
        strong: Map<RelationTypeId, RelationType>,
        evidence: List<EvidenceRef>,
        evidenceProblem: String?,
    ): Pair<StrongUpgradeProposal?, String?> {
        val typeId = dto.strongTypeId?.trim().orEmpty()
        val raw = dto.strongSourceId?.trim().orEmpty()
        val refs = mapOf(AnalysisPromptText.personRef(0) to item.first.id, AnalysisPromptText.personRef(1) to item.second.id)
        val source = AnalysisPromptText.resolvePerson(raw, refs)
        val pair = item.case.pair
        val problem = when {
            typeId.isEmpty() || strong[RelationTypeId(typeId)] == null -> "强类型「$typeId」不在可选硬 / 中类型之中"
            source == null || (source != pair.first && source != pair.second) -> "源端「$raw」不属于该人物对"
            dto.strongBasis.isBlank() -> "没有说明依据"
            else -> evidenceProblem
        }
        if (problem != null) return null to problem
        return StrongUpgradeProposal(pair, RelationTypeId(typeId), source!!, dto.strongBasis.trim(), evidence.distinctBy { it.id }) to null
    }
}
