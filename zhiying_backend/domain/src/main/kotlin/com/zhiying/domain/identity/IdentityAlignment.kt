// 身份对齐：把各章的人物提及与身份主张对齐成全书统一的人物列表、身份映射和出场章节。
// 纯规则，不调用模型：真正有歧义的部分只产出 IdentityAmbiguity，由应用层交给身份判断后再回灌。
package com.zhiying.domain.identity

import com.zhiying.domain.extraction.ChapterExtraction
import com.zhiying.domain.library.ChapterId

/**
 * 身份歧义问题：一组因共享名称而互为候选的人物，附资料与各自的提及上下文。
 *
 * 候选组不等于合并组：问题只说明"这些人物可能是同一人"，是否合并由针对性判断给出的 [IdentityDecision] 决定。
 * [mentions] 含上下文指代的提及，供判断时参考；这些提及本身不会成为全书别名。
 */
data class IdentityAmbiguity(
    val candidates: Set<PersonId>,
    val persons: List<Person>,
    val sharedNames: Set<String>,
    val mentions: Map<PersonId, List<PersonMention>>,
) {
    init {
        require(candidates.size >= 2) { "候选组至少两人" }
    }

    /**
     * 校验针对本问题的身份结论，返回第一处问题的说明；没有问题时返回 null。
     *
     * 规则：结论只能涉及候选组内的人物；同人组之间不得重叠；
     * 同一同人组内的两人不能同时被判为不同人或未决。
     */
    fun validate(decisions: List<IdentityDecision>): String? {
        val unknown = decisions.flatMap { it.persons } - candidates
        if (unknown.isNotEmpty()) return "结论涉及候选组之外的人物: ${unknown.map { it.value }}"
        val groups = decisions.filterIsInstance<IdentityDecision.SamePerson>().map { it.persons }
        if (groups.flatten().size != groups.flatten().toSet().size) return "同人组相互重叠"
        val others = decisions.filterNot { it is IdentityDecision.SamePerson }
        val contradicted = groups.any { same -> others.any { (it.persons intersect same).size >= 2 } }
        return if (contradicted) "同一同人组内的人物又被判为不同人或未决" else null
    }
}

/** 对一个歧义问题的回答：针对哪个候选组，给出了哪些结论。 */
data class DisambiguationAnswer(val candidates: Set<PersonId>, val decisions: List<IdentityDecision>)

/**
 * 身份对齐的最终产物。
 *
 * [persons] 为合并后的书内人物（不含已被并入者）；[identityMap] 解析全部已绑定的局部人物；
 * [appearances] 为每个人物出场的章节；[unbound] 为没有任何可用称呼、无法成为人物的局部人物
 * （其作为端点的关系无法构建）；[rejections] 为被程序拒绝的身份结论及原因。
 */
data class AlignedIdentities(
    val persons: List<Person>,
    val identityMap: IdentityMap,
    val appearances: Map<PersonId, Set<ChapterId>>,
    val unbound: Set<LocalPersonRef>,
    val rejections: List<String>,
)

/**
 * 身份对齐的过程状态（不可变快照）。
 *
 * 用法：[start] 处理全部章节得到初步对齐和歧义问题 → 应用层把 [ambiguities] 交给身份判断 →
 * [apply] 校验并登记合并 → [result] 取最终产物。
 *
 * 规则：
 * - 主张绑定到已有人物且该人物确实存在：直接采用，并保存新别名；
 * - 否则新建人物，其称呼可能与已有人物重名，由名称索引连成候选组，进入歧义问题；
 * - 仅在本次上下文成立的指代（如"父亲""那个老人"）不进入全书别名，也不参与候选连接；
 * - 没有任何稳定称呼又没有绑定到已有人物的局部人物保持未绑定，不编造人物。
 */
class IdentityAlignment private constructor(
    private val persons: Map<PersonId, Person>,
    private val identityMap: IdentityMap,
    private val locals: Map<LocalPersonRef, PersonId>,
    private val mentionsByPerson: Map<PersonId, List<PersonMention>>,
    private val unbound: Set<LocalPersonRef>,
    private val pending: List<IdentityAmbiguity>,
    private val rejections: List<String>,
) {
    /** 尚未得到回答的身份歧义问题。 */
    val ambiguities: List<IdentityAmbiguity> get() = pending

    /**
     * 应用身份判断的回答：校验后用 [IdentityMap] 登记合并，非法回答整体拒绝并保持相关人物独立。
     * 只有 [IdentityDecision.SamePerson] 才合并，保留者是候选组中最早出现的人物；没有回答的候选组保持独立。
     */
    fun apply(answers: List<DisambiguationAnswer>): IdentityAlignment =
        answers.fold(this) { state, answer -> state.applyOne(answer) }

    /** 取最终产物：人物列表、身份映射与每个人物的出场章节。 */
    fun result(): AlignedIdentities = AlignedIdentities(
        persons = persons.values.toList(),
        identityMap = identityMap,
        appearances = locals.entries
            .groupBy({ identityMap.canonical(it.value) }, { it.key.chapterId })
            .mapValues { (_, chapters) -> chapters.toCollection(linkedSetOf()) },
        unbound = unbound,
        rejections = rejections,
    )

    /** 处理一份回答：未知候选组或校验失败则拒绝，否则登记其中的同人结论。 */
    private fun applyOne(answer: DisambiguationAnswer): IdentityAlignment {
        val ambiguity = pending.firstOrNull { it.candidates == answer.candidates }
            ?: return copy(rejections = rejections + "回答针对未知候选组: ${answer.candidates.map { it.value }}")
        val remaining = pending - ambiguity
        val problem = ambiguity.validate(answer.decisions)
        if (problem != null) return copy(pending = remaining, rejections = rejections + problem)
        return answer.decisions.filterIsInstance<IdentityDecision.SamePerson>()
            .fold(copy(pending = remaining)) { state, same -> state.mergeGroup(same.persons) }
    }

    /** 登记一组同人：保留者取最早出现者，其余并入保留者，名称绑定与资料随之合并。 */
    private fun mergeGroup(group: Set<PersonId>): IdentityAlignment {
        val order = persons.keys.toList()
        val ordered = group.sortedBy { order.indexOf(it) }
        val survivor = ordered.first()
        var merged = persons[survivor]!!
        var map = identityMap
        for (absorbed in ordered.drop(1)) {
            merged = merged.absorb(persons.getValue(absorbed))
            map = map.merge(absorbed, survivor)
        }
        val remaining = persons.filterKeys { it !in ordered.drop(1) } + (survivor to merged)
        return copy(persons = remaining, identityMap = map)
    }

    /** 安放一个局部人物：绑定到主张的已有人物，或新建人物，或保持未绑定；主张里的简介等资料只补空缺。 */
    private fun place(local: LocalPersonRef, extraction: ChapterExtraction): IdentityAlignment {
        val mentions = extraction.mentions.filter { it.person == local }
        val claim = extraction.claims.firstOrNull { it.person == local }
        val claimed = claim?.existing?.takeIf { it in persons }
        val target = claimed ?: PersonId("p:${local.chapterId.value}:${local.key}")
        val bindings = mentions.mapNotNull { it.toBinding(target) }
        val updated = when {
            claimed != null -> bindings.fold(persons.getValue(claimed)) { person, binding -> person.bind(binding) }
            bindings.isEmpty() -> return copy(unbound = unbound + local)
            else -> Person(target, withAnchorName(bindings))
        }.fillDetails(claim)
        return copy(
            persons = persons + (target to updated),
            identityMap = identityMap.bind(local, target),
            locals = locals + (local to target),
            mentionsByPerson = mentionsByPerson + (target to mentionsByPerson[target].orEmpty() + mentions),
        )
    }

    /** 由名称索引生成候选组，每组打包成一个歧义问题；[appellationLimit] 见 [NameIndex.bridging]。 */
    private fun withAmbiguities(appellationLimit: Int): IdentityAlignment {
        val groups = NameIndex.bridging(persons.values, appellationLimit).candidateGroups()
        val questions = groups.map { ids ->
            val members = ids.map { persons.getValue(it) }
            val shared = members.flatMap { it.names }.groupingBy { it }.eachCount().filterValues { it >= 2 }.keys
            IdentityAmbiguity(ids, members, shared, ids.associateWith { mentionsByPerson[it].orEmpty() })
        }
        return copy(pending = questions)
    }

    private fun copy(
        persons: Map<PersonId, Person> = this.persons,
        identityMap: IdentityMap = this.identityMap,
        locals: Map<LocalPersonRef, PersonId> = this.locals,
        mentionsByPerson: Map<PersonId, List<PersonMention>> = this.mentionsByPerson,
        unbound: Set<LocalPersonRef> = this.unbound,
        pending: List<IdentityAmbiguity> = this.pending,
        rejections: List<String> = this.rejections,
    ) = IdentityAlignment(persons, identityMap, locals, mentionsByPerson, unbound, pending, rejections)

    companion object {
        /**
         * 对齐全部章节。
         *
         * 入参：[roster] 已有人名册（首次分析为空，重跑时为上一版人物，人物 ID 保持稳定）；
         * [extractions] 各章抽取，须按阅读顺序排列，保留者与展示名据此取最早出现者；
         * [appellationLimit] 稳定称呼参与候选桥接的共用人数上限。
         * 出参：初步对齐状态，其中 [ambiguities] 为待判断的歧义问题。
         */
        fun start(
            roster: List<Person>,
            extractions: List<ChapterExtraction>,
            appellationLimit: Int = NameIndex.DEFAULT_APPELLATION_BRIDGE_LIMIT,
        ): IdentityAlignment {
            val empty = IdentityAlignment(
                roster.associateBy { it.id }, IdentityMap.EMPTY, emptyMap(), emptyMap(), emptySet(), emptyList(), emptyList(),
            )
            val placed = extractions.fold(empty) { state, extraction ->
                extraction.persons.fold(state) { inner, local -> inner.place(local, extraction) }
            }
            return placed.withAmbiguities(appellationLimit)
        }

        /** 新建人物至少要有一个正式名或稳定称呼：只有别名时，把最先出现的别名当作稳定称呼。 */
        private fun withAnchorName(bindings: List<NameBinding>): List<NameBinding> {
            val distinct = bindings.distinctBy { it.name to it.kind }
            if (distinct.any { it.kind != NameKind.ALIAS }) return distinct
            return listOf(distinct.first().copy(kind = NameKind.STABLE_APPELLATION)) + distinct.drop(1)
        }
    }
}
