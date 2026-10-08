// 团体归纳的基础设施实现：一次结构化调用得到团体与成员，人物按短代号解析回 ID；空名、关系词当团体名、重名交还模型重答，
// 个别成员代号认不出只丢该成员并记日志，不让一处笔误拖垮整份回复。预算、重试、用量由 StructuredCallExecutor / ModelInvoker 负责。
package com.zhiying.infrastructure.llm.affiliations

import com.zhiying.application.analyze.affiliations.AffiliationInducer
import com.zhiying.application.analyze.affiliations.AffiliationRequest
import com.zhiying.application.analyze.affiliations.InducedGroup
import com.zhiying.application.analyze.affiliations.InducedMember
import com.zhiying.application.analyze.affiliations.InductionResult
import com.zhiying.application.llm.ModelCallControl
import com.zhiying.domain.identity.PersonId
import com.zhiying.domain.library.ChapterId
import com.zhiying.infrastructure.config.ZhiYingProperties
import com.zhiying.infrastructure.llm.StructuredCallExecutor
import com.zhiying.infrastructure.llm.StructuredOutcome
import com.zhiying.infrastructure.llm.analysis.AnalysisPromptText
import com.zhiying.infrastructure.llm.ask
import org.apache.commons.logging.LogFactory
import org.springframework.stereotype.Component

/** 模型回复：团体列表。字段全部可空，缺字段由校验反馈给模型。 */
internal data class AffiliationReply(val groups: List<GroupReply>? = null)

/** 一个团体；kind 取值见 [AFFILIATION_KINDS]，其余取值按 other 处理。 */
internal data class GroupReply(
    val name: String? = null,
    val kind: String? = null,
    val note: String? = null,
    val members: List<MemberReply>? = null,
)

/** 一个成员：personId 为人名册短代号（P1……），chapters 为活跃章的阅读序号。 */
internal data class MemberReply(
    val personId: String? = null,
    val role: String? = null,
    val chapters: List<Int>? = null,
    val note: String? = null,
    val quote: String? = null,
)

/** 团体归纳的模型实现。 */
@Component
class SpringAiAffiliationInducer(
    private val executor: StructuredCallExecutor,
    private val properties: ZhiYingProperties,
) : AffiliationInducer {

    /**
     * 执行归纳：渲染提示 → 一次结构化调用（带业务校验）→ 把回复转成团体。
     * 执行失败或重答用尽返回 [InductionResult.Failed]，不抛异常、不伪造。
     */
    override fun induce(request: AffiliationRequest, control: ModelCallControl): InductionResult {
        val config = properties.affiliations
        val refs = AffiliationPrompts.refs(request).entries.associate { (id, ref) -> ref to id }
        val outcome = executor.ask<AffiliationReply>(
            system = AffiliationPrompts.system(config.minGroups, config.maxGroups),
            user = AffiliationPrompts.user(request),
            model = config.model.ifBlank { null },
            thinking = config.thinking,
            control = control,
        ) { reply -> validate(reply, refs, request.forbiddenNames) }
        return when (outcome) {
            is StructuredOutcome.Failed -> InductionResult.Failed("团体归纳未完成（${outcome.failure}）：${outcome.message}")
            is StructuredOutcome.Success -> InductionResult.Induced(convert(outcome.value, request, refs))
        }
    }

    /**
     * 校验回复：团体名非空、不是关系词、不重名，成员非空，且认得出的成员过半（大面积认不出说明模型没用代号，要求重答）；
     * 返回问题说明，通过为 null。个别认不出的成员在 [convert] 里丢弃。
     */
    private fun validate(reply: AffiliationReply, refs: Map<String, PersonId>, forbidden: Set<String>): String? {
        val groups = reply.groups
        if (groups.isNullOrEmpty()) return "groups 不能为空"
        val seen = mutableSetOf<String>()
        groups.forEachIndexed { i, g ->
            val name = g.name?.trim().orEmpty()
            val problem = when {
                name.isEmpty() -> "groups[$i]: name 不能为空"
                name in forbidden -> "groups[$i]: '$name' 是关系类型，不能当团体名；团体名要用学校/教会/家族/组织等专有名词"
                !seen.add(name) -> "groups[$i]: 团体名 '$name' 重复"
                g.members.isNullOrEmpty() -> "groups[$i] '$name': members 不能为空"
                else -> null
            }
            if (problem != null) return problem
        }
        val all = groups.flatMap { it.members.orEmpty() }
        val unknown = all.map { it.personId.orEmpty() }.filter { resolve(it, refs) == null }
        if (unknown.size * 2 > all.size) {
            return "有 ${unknown.size}/${all.size} 个成员的 personId 不是人名册代号（如 '${unknown.first()}'）；personId 必须填人名册行首的代号，如 P3"
        }
        return null
    }

    /** 代号或完整 ID 解析为人物；空串或认不出为 null。 */
    private fun resolve(raw: String, refs: Map<String, PersonId>): PersonId? =
        raw.takeIf { it.isNotBlank() }?.let { AnalysisPromptText.resolvePerson(it, refs) }

    /** 回复转成团体：代号解析回人物 ID，认不出的成员丢弃并记日志；成员同团体内去重，章号映射回章节 ID，未知类别按 other。 */
    private fun convert(reply: AffiliationReply, request: AffiliationRequest, refs: Map<String, PersonId>): List<InducedGroup> {
        val chapterIds: Map<Int, ChapterId> = request.chapters.associate { it.number to it.chapterId }
        return reply.groups.orEmpty().map { g ->
            val kind = g.kind?.trim()?.lowercase()?.takeIf { it in AFFILIATION_KINDS } ?: "other"
            val (known, unknown) = g.members.orEmpty().partition { resolve(it.personId.orEmpty(), refs) != null }
            if (unknown.isNotEmpty()) {
                log.warn("团体「${g.name}」丢弃 ${unknown.size} 个认不出的成员：${unknown.joinToString { it.personId.orEmpty() }}")
            }
            val members = known.distinctBy { resolve(it.personId.orEmpty(), refs) }.map { m ->
                InducedMember(
                    person = resolve(m.personId.orEmpty(), refs)!!,
                    role = m.role,
                    chapters = m.chapters.orEmpty().mapNotNull { chapterIds[it] }.distinct(),
                    note = m.note,
                    quote = m.quote,
                )
            }
            InducedGroup(g.name!!.trim(), kind, g.note, members)
        }
    }

    private val log = LogFactory.getLog(SpringAiAffiliationInducer::class.java)

    companion object {
        /** 提示词版本，供任务记录引用。 */
        const val PROMPT_VERSION = AFFILIATION_PROMPT_VERSION
    }
}
