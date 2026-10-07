// 类型归一端口、类型语义缓存端口与归一步骤。
package com.zhiying.application.analyze.relations

import com.zhiying.application.analyze.BatchLimits
import com.zhiying.application.analyze.boundedBatches
import com.zhiying.application.llm.ModelCallControl
import com.zhiying.domain.extraction.ChapterExtraction
import com.zhiying.domain.relations.RelationTypeLibrary
import com.zhiying.domain.relations.TypeDecision
import com.zhiying.domain.relations.TypeNormalization
import com.zhiying.domain.relations.TypeQuestion
import com.zhiying.domain.relations.TypeSemanticKey

/**
 * 一批类型问题。[library] 是当前完整类型库（实现方可自行检索有限候选以控制提示长度），
 * [questions] 已按语义键去重，每个问题附建议类型的名称、定义、硬度、方向与少量原文描述样例。
 */
data class TypeResolutionRequest(
    val library: RelationTypeLibrary,
    val questions: List<TypeQuestion>,
    val control: ModelCallControl = ModelCallControl(),
)

/** 对一个类型问题的回答，以语义键关联。 */
data class TypeAnswer(val key: TypeSemanticKey, val decision: TypeDecision)

/**
 * 类型归一端口（结构化输出，有界小批，适合小模型）。
 *
 * 只回答"属于什么关系、方向如何对应"，不回答"原文是否成立"。契约：
 * - 仅当定义、双方角色、方向与具体程度等价时才归入已有类型（[TypeDecision.UseExisting]）；
 *   精确类型（哥哥、表弟等）不得降级成宽泛兜底类型（兄弟姐妹、堂表亲）；
 *   方向对应相对于"建议类型的角色顺序"：与已有类型方向一致为 AS_OBSERVED，相反为 REVERSED；
 * - 没有语义等价项且定义清楚时给出 [TypeDecision.NewType]，名称不得是情节句子；无法确定给 [TypeDecision.Unresolved]；
 * - 执行失败（超时、预算耗尽）时对应问题不回答，候选保持未归一，不等于被否定。
 */
interface RelationTypeResolver {
    /** 判断一批类型问题，返回已给出结论的问题的回答。 */
    fun resolve(request: TypeResolutionRequest): List<TypeAnswer>
}

/**
 * 类型语义缓存端口。键见 [TypeSemanticKey]：与具体候选、人物、章节无关，
 * 并含类型库指纹与策略版本，所以类型库或策略变化后旧结论自然不再命中。
 * 证据语义判断（"这些人确实是朋友"）不使用本缓存。
 */
interface TypeDecisionCache {
    /** 取已缓存的结论；未命中返回 null。 */
    fun get(key: TypeSemanticKey): TypeDecision?

    /** 保存一次语义结论。 */
    fun put(key: TypeSemanticKey, decision: TypeDecision)

    companion object {
        /** 不缓存。 */
        val NONE: TypeDecisionCache = object : TypeDecisionCache {
            override fun get(key: TypeSemanticKey): TypeDecision? = null
            override fun put(key: TypeSemanticKey, decision: TypeDecision) = Unit
        }
    }
}

/**
 * 类型归一步骤（应用层编排，非 Spring Bean）。
 *
 * 顺序：领域按名称确定性匹配 → 剩余问题先查语义缓存 → 未命中的分批交给 [RelationTypeResolver]
 * （副作用：模型调用、写缓存）→ 领域登记新类型或归入已有类型。
 */
class TypeNormalizationStep(
    private val resolver: RelationTypeResolver,
    private val cache: TypeDecisionCache = TypeDecisionCache.NONE,
    private val limits: BatchLimits = BatchLimits(maxItems = 10, maxChars = 8_000),
    private val control: ModelCallControl = ModelCallControl(),
) {
    /**
     * 对全书候选做类型归一。
     * 入参：[library] 当前类型库；[extractions] 各章抽取。
     * 出参：归一状态，含更新后的类型库与每条候选的结论；未回答的候选没有结论。
     */
    fun run(library: RelationTypeLibrary, extractions: List<ChapterExtraction>): TypeNormalization {
        val candidates = extractions.flatMap { extraction -> extraction.candidates.map { extraction.chapterId to it } }
        val begun = TypeNormalization.begin(library, candidates)
        // 先用缓存回灌，命中的问题不再调用模型
        val afterCache = begun.questions.fold(begun) { state, question ->
            cache.get(question.key)?.let { state.answer(question.key, it) } ?: state
        }
        val batches = boundedBatches(afterCache.questions, limits) { q ->
            q.proposal.definition.length + q.examples.sumOf(String::length)
        }
        // 再按批调用模型；库在批间可能已登记新类型，所以每批都用最新状态组织请求
        return batches.fold(afterCache) { state, batch -> answerBatch(state, batch) }
    }

    /** 处理一批：调用端口，只接受确实属于本批的回答，并把非"未归一"的结论写入缓存。 */
    private fun answerBatch(state: TypeNormalization, batch: List<TypeQuestion>): TypeNormalization {
        val answers = resolver.resolve(TypeResolutionRequest(state.library, batch, control))
        val asked = batch.associateBy { it.key }
        return answers.filter { it.key in asked }.distinctBy { it.key }.fold(state) { current, answer ->
            if (answer.decision !is TypeDecision.Unresolved) cache.put(answer.key, answer.decision)
            current.answer(answer.key, answer.decision)
        }
    }
}
