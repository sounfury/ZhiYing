// 关系类型归一的 Spring AI 实现：一批类型问题一次结构化调用，回复转成 TypeDecision，非法项丢弃并记日志。
package com.zhiying.infrastructure.llm.analysis

import com.zhiying.application.analyze.relations.RelationTypeResolver
import com.zhiying.application.analyze.relations.TypeAnswer
import com.zhiying.application.analyze.relations.TypeResolutionRequest
import com.zhiying.domain.relations.Direction
import com.zhiying.domain.relations.Hardness
import com.zhiying.domain.relations.Orientation
import com.zhiying.domain.relations.RelationTypeId
import com.zhiying.domain.relations.RelationTypeLibrary
import com.zhiying.domain.relations.TypeDecision
import com.zhiying.domain.relations.TypeQuestion
import com.zhiying.infrastructure.config.ZhiYingProperties
import com.zhiying.infrastructure.llm.StructuredCallExecutor
import com.zhiying.infrastructure.llm.StructuredOutcome
import com.zhiying.infrastructure.llm.ask
import org.slf4j.LoggerFactory
import org.springframework.stereotype.Component

/** 模型回复：每个问题一项结论。 */
internal data class TypeReply(val items: List<TypeItemDto> = emptyList())

/** 对一个类型问题的结论：action 为 existing / new / unresolved。 */
internal data class TypeItemDto(
    val id: String = "",
    val action: String = "",
    val typeId: String? = null,
    val reverse: Boolean = false,
    val newType: NewTypeDto? = null,
    val reason: String = "",
)

/** 新类型：hardness 为 hard / medium / soft；direction 为 undirected / directed。 */
internal data class NewTypeDto(
    val name: String = "",
    val definition: String = "",
    val hardness: String = "",
    val direction: String = "",
    val sourceRole: String? = null,
    val targetRole: String? = null,
    val synonyms: List<String> = emptyList(),
)

/**
 * 基于结构化调用的类型归一。
 *
 * 执行失败时返回空列表：对应候选保持未归一，不等于被否定。程序侧丢弃的非法项：未知问题编号、
 * 类型库之外的类型、硬关系建议被归入软类型、过长或带标点的新类型名称（视为情节句子）、定义或角色缺失的新类型、
 * 缺失 / 无法识别的 action。
 */
@Component
class SpringAiRelationTypeResolver(
    private val executor: StructuredCallExecutor,
    properties: ZhiYingProperties,
) : RelationTypeResolver {
    private val config = properties.postProcess
    private val log = LoggerFactory.getLogger(SpringAiRelationTypeResolver::class.java)

    /**
     * 判断一批类型问题。
     * 入参：[request] 类型库、问题与任务级控制。出参：通过程序校验的回答；失败时为空。
     */
    override fun resolve(request: TypeResolutionRequest): List<TypeAnswer> {
        val candidates = TypeResolutionPrompts.candidatesFor(request.library, request.questions, config.typeCandidateLimit)
        val outcome = executor.ask<TypeReply>(
            system = TypeResolutionPrompts.SYSTEM,
            user = TypeResolutionPrompts.user(candidates, request.questions),
            model = AnalysisPromptText.modelOf(config.model),
            thinking = config.thinking,
            control = request.control,
        )
        return when (outcome) {
            is StructuredOutcome.Failed -> {
                log.warn("类型归一未完成（{}），{} 个问题保持未归一：{}", outcome.failure, request.questions.size, outcome.message)
                emptyList()
            }
            is StructuredOutcome.Success -> convert(outcome.value, request.questions, request.library)
        }
    }

    /** 回复转领域回答：按问题编号对应，逐项校验，非法项记日志丢弃。 */
    private fun convert(reply: TypeReply, questions: List<TypeQuestion>, library: RelationTypeLibrary): List<TypeAnswer> {
        val byId = questions.withIndex().associate { TypeResolutionPrompts.questionId(it.index) to it.value }
        return reply.items.distinctBy { it.id }.mapNotNull { item ->
            val question = byId[item.id]
            if (question == null) {
                log.warn("丢弃类型结论：未知问题编号 {}", item.id)
                return@mapNotNull null
            }
            toDecision(item, question, library)?.let { TypeAnswer(question.key, it) }
        }
    }

    /** 单项结论转领域对象；校验不通过返回 null。 */
    private fun toDecision(item: TypeItemDto, question: TypeQuestion, library: RelationTypeLibrary): TypeDecision? {
        val reason = item.reason.trim().ifBlank { "模型未说明理由" }
        return when (item.action.trim().lowercase()) {
            "existing" -> existing(item, question, library, reason)
            "new" -> newType(item, question, reason)
            "unresolved" -> TypeDecision.Unresolved(reason)
            else -> {
                log.warn("丢弃类型结论 {}：无法识别的 action「{}」", item.id, item.action)
                null
            }
        }
    }

    /** 归入已有类型：类型必须在库中，且硬 / 中建议不得归入软类型（视为降级）。 */
    private fun existing(item: TypeItemDto, question: TypeQuestion, library: RelationTypeLibrary, reason: String): TypeDecision? {
        val id = item.typeId?.trim().orEmpty()
        val type = if (id.isEmpty()) null else library[RelationTypeId(id)]
        val problem = when {
            type == null -> "类型库中没有类型「$id」"
            question.proposal.hardness.strong && type.hardness == Hardness.SOFT -> "硬 / 中关系建议被归入软类型《${type.name}》"
            else -> null
        }
        if (problem != null) {
            log.warn("丢弃类型结论 {}（{}）：{}", item.id, question.proposal.name, problem)
            return null
        }
        val orientation = if (item.reverse) Orientation.REVERSED else Orientation.AS_OBSERVED
        return TypeDecision.UseExisting(RelationTypeId(id), orientation, reason)
    }

    /** 新建类型：名称须是关系名而非情节句子，定义、硬度、方向与角色齐全。 */
    private fun newType(item: TypeItemDto, question: TypeQuestion, reason: String): TypeDecision? {
        val dto = item.newType
        val problem = newTypeProblem(dto)
        if (dto == null || problem != null) {
            log.warn("丢弃类型结论 {}（{}）：新类型无效，{}", item.id, question.proposal.name, problem ?: "缺少 newType")
            return null
        }
        val name = dto.name.trim()
        val hardness = AnalysisPromptText.parseHardness(dto.hardness)!!
        val direction = if (dto.direction.trim().equals("directed", ignoreCase = true)) {
            Direction.Directed(dto.sourceRole!!.trim(), dto.targetRole!!.trim())
        } else {
            Direction.Undirected
        }
        val synonyms = dto.synonyms.map { it.trim() }.filter { it.isNotEmpty() && it != name }.toSet()
        return TypeDecision.NewType(name, dto.definition.trim(), hardness, direction, synonyms, reason)
    }

    /** 新类型的问题说明；合法返回 null。 */
    private fun newTypeProblem(dto: NewTypeDto?): String? = when {
        dto == null -> "缺少 newType"
        dto.name.isBlank() || dto.definition.isBlank() -> "名称或定义为空"
        dto.name.trim().length > config.maxNewTypeNameChars || dto.name.any { it in SENTENCE_MARKS } ->
            "名称「${dto.name}」像情节句子而不是关系名称"
        AnalysisPromptText.parseHardness(dto.hardness) == null -> "无法识别的硬度「${dto.hardness}」"
        dto.direction.trim().lowercase() !in setOf("undirected", "directed") -> "无法识别的方向「${dto.direction}」"
        dto.direction.trim().equals("directed", ignoreCase = true) &&
            (dto.sourceRole.isNullOrBlank() || dto.targetRole.isNullOrBlank()) -> "有向类型缺少两端角色"
        else -> null
    }

    private companion object {
        /** 出现在名称里就说明它是句子而不是关系名。 */
        val SENTENCE_MARKS = setOf('，', '。', '、', '；', '：', ',', '.', ';', ':', '！', '？', '!', '?', '「', '」', '“', '”')
    }
}
