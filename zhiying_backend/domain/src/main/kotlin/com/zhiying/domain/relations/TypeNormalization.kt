// 类型归一：把候选引用的类型（已知类型 ID 或新类型建议）落到本书类型库中的规范类型，并确定方向对应。
// 先按名称确定性匹配，剩余的新类型建议才形成"类型问题"交给模型判断；模型回答经校验后登记新类型或归入已有类型。
package com.zhiying.domain.relations

import com.zhiying.domain.library.ChapterId

/** 候选在全书范围内的引用。候选 ID 只保证章内唯一，跨章必须带上章节。 */
data class CandidateRef(val chapterId: ChapterId, val candidate: CandidateId)

/**
 * 类型语义缓存的键（DESIGN §3.3）。
 *
 * 键由"问题的语义"组成：建议类型的名称、定义、硬度、方向与角色，加上类型库指纹和策略版本。
 * 与具体哪条候选、哪个人物、哪一章无关，所以"多章都用了朋友这个词"可以共享类型定义；
 * 而"这些人确实是朋友"这类证据结论不在此缓存，必须另按人物、规范类型、正文版本与证据上下文缓存。
 * 类型库或策略变化后指纹随之改变，旧缓存自然失效。
 */
data class TypeSemanticKey(
    val name: String,
    val definition: String,
    val hardness: Hardness,
    val direction: Direction,
    val libraryFingerprint: String,
    val policyVersion: String = POLICY_VERSION,
) {
    /** 可直接用作缓存主键的稳定文本。 */
    val text: String
        get() = listOf(policyVersion, libraryFingerprint, name, hardness, direction, definition).joinToString("|")

    companion object {
        /** 归一策略版本；提示词或归一规则变化时递增。 */
        const val POLICY_VERSION = "type-normalization-1"

        /** 由新类型建议和当前类型库生成键。 */
        fun of(proposal: TypeProposal, library: RelationTypeLibrary) = TypeSemanticKey(
            name = proposal.name.trim(),
            definition = proposal.definition.trim(),
            hardness = proposal.hardness,
            direction = proposal.direction,
            libraryFingerprint = library.fingerprint,
        )
    }
}

/**
 * 一个需要判断的类型问题：同一语义键下的全部候选共用一次判断。
 *
 * [examples] 是少量原文描述样例，帮助判断建议类型的实际含义。
 */
data class TypeQuestion(
    val key: TypeSemanticKey,
    val proposal: TypeProposal,
    val candidates: List<CandidateRef>,
    val examples: List<String>,
)

/** 对类型问题的结论。方向对应关系相对于"建议类型的角色顺序"，因此可跨候选复用。 */
sealed interface TypeDecision {
    /** 判断理由。 */
    val reason: String

    /** 归入类型库中已有的类型；[orientation] 表示建议类型的两端与已有类型的方向是否一致。 */
    data class UseExisting(
        val type: RelationTypeId,
        val orientation: Orientation,
        override val reason: String,
    ) : TypeDecision {
        init {
            require(reason.isNotBlank()) { "类型判断必须说明理由" }
        }
    }

    /** 登记为本书新类型；同义名由程序去重，名称与已有类型冲突时自动改为归入已有类型。 */
    data class NewType(
        val name: String,
        val definition: String,
        val hardness: Hardness,
        val direction: Direction,
        val synonyms: Set<String> = emptySet(),
        override val reason: String,
    ) : TypeDecision {
        init {
            require(name.isNotBlank() && name == name.trim()) { "新类型名称不能为空，且须去除首尾空白" }
            require(definition.isNotBlank()) { "新类型必须有定义" }
            require(reason.isNotBlank()) { "类型判断必须说明理由" }
        }
    }

    /** 无法归一：保留原文描述，不进入关系事实。 */
    data class Unresolved(override val reason: String) : TypeDecision {
        init {
            require(reason.isNotBlank()) { "未归一必须说明原因" }
        }
    }
}

/**
 * 全书类型归一的过程状态（不可变快照）。
 *
 * [begin] 先做确定性处理：引用类型库已有 ID、或建议类型的名称精确命中类型库（含方向）的候选直接归一；
 * 其余按语义键聚合成 [questions]。应用层用 [answer] 逐个回灌模型结论，登记的新类型进入 [library]。
 */
class TypeNormalization private constructor(
    val library: RelationTypeLibrary,
    private val resolved: Map<CandidateRef, TypeResolution>,
    val questions: List<TypeQuestion>,
) {
    /** 已有结论的候选；尚未回答的问题中的候选不在其中。 */
    fun resolutions(): Map<CandidateRef, TypeResolution> = resolved

    /**
     * 回灌一个问题的结论，返回新状态。
     *
     * - [TypeDecision.UseExisting]：类型必须在库中；无向类型的方向对应一律按观察顺序；
     * - [TypeDecision.NewType]：先按名称再匹配一次当前类型库（前面刚登记的同名类型直接复用），否则登记为本书新类型；
     * - [TypeDecision.Unresolved]：问题中的候选标为未归一。
     */
    fun answer(key: TypeSemanticKey, decision: TypeDecision): TypeNormalization {
        val question = questions.first { it.key == key }
        val (nextLibrary, settlement) = settle(decision)
        val results = question.candidates.associateWith { ref -> settlement.forCandidate(ref.candidate) }
        return TypeNormalization(nextLibrary, resolved + results, questions - question)
    }

    /** 把结论落实到类型库：返回新的类型库与对问题整体的处置。 */
    private fun settle(decision: TypeDecision): Pair<RelationTypeLibrary, Settlement> = when (decision) {
        is TypeDecision.Unresolved -> library to Settlement.Failed(decision.reason)
        is TypeDecision.UseExisting -> library to useExisting(decision.type, decision.orientation, decision.reason)
        is TypeDecision.NewType -> registerOrReuse(decision)
    }

    /** 归入已有类型；类型不在库中时视为未归一。 */
    private fun useExisting(id: RelationTypeId, orientation: Orientation, reason: String): Settlement {
        val type = library[id] ?: return Settlement.Failed("模型返回了类型库之外的类型: ${id.value}")
        val effective = if (type.direction is Direction.Directed) orientation else Orientation.AS_OBSERVED
        return Settlement.Placed(id, effective, reason)
    }

    /** 登记本书新类型；名称已被占用时直接复用占用者。 */
    private fun registerOrReuse(decision: TypeDecision.NewType): Pair<RelationTypeLibrary, Settlement> {
        library.match(decision.name)?.let { hit ->
            return library to Settlement.Placed(hit.type.id, hit.orientation, "名称已对应类型《${hit.type.name}》：${decision.reason}")
        }
        val taken = library.types.flatMap { it.allNames }.toSet() + decision.name
        val type = RelationType(
            id = RelationTypeId("book:${decision.name}"),
            name = decision.name,
            definition = decision.definition,
            hardness = decision.hardness,
            direction = decision.direction,
            synonyms = decision.synonyms - taken,
            origin = TypeOrigin.BOOK,
        )
        return library.register(type) to Settlement.Placed(type.id, Orientation.AS_OBSERVED, "登记本书新类型：${decision.reason}")
    }

    companion object {
        /**
         * 开始归一：做确定性匹配并汇集剩余问题。
         *
         * 入参：[library] 本书当前类型库；[candidates] 全书范围内的候选（与所在章配对）。
         * 出参：状态，其中 [questions] 为需要模型判断的类型问题，已按语义键去重。
         */
        fun begin(library: RelationTypeLibrary, candidates: List<Pair<ChapterId, RelationCandidate>>): TypeNormalization {
            val resolved = linkedMapOf<CandidateRef, TypeResolution>()
            val waiting = linkedMapOf<TypeSemanticKey, MutableList<Pair<CandidateRef, RelationCandidate>>>()
            for ((chapter, candidate) in candidates) {
                val ref = CandidateRef(chapter, candidate.id)
                val settled = deterministic(library, candidate)
                if (settled != null) {
                    resolved[ref] = settled
                } else {
                    val proposal = (candidate.type as TypeReference.Proposed).proposal
                    waiting.getOrPut(TypeSemanticKey.of(proposal, library)) { mutableListOf() }.add(ref to candidate)
                }
            }
            val questions = waiting.map { (key, members) ->
                val proposal = (members.first().second.type as TypeReference.Proposed).proposal
                TypeQuestion(key, proposal, members.map { it.first }, members.map { it.second.description }.distinct().take(3))
            }
            return TypeNormalization(library, resolved, questions)
        }

        /** 确定性快路径：能直接归一时返回结论，需要模型判断（新类型建议且名称未命中）时返回 null。 */
        private fun deterministic(library: RelationTypeLibrary, candidate: RelationCandidate): TypeResolution? =
            when (val type = candidate.type) {
                is TypeReference.Known -> library[type.id]
                    ?.let { TypeResolution.Resolved(candidate.id, it.id, Orientation.AS_OBSERVED, "引用类型库中的类型《${it.name}》") }
                    ?: TypeResolution.Unresolved(candidate.id, "类型库中没有类型 ${type.id.value}")
                is TypeReference.Proposed -> library.match(type.proposal.name)?.let {
                    TypeResolution.Resolved(candidate.id, it.type.id, it.orientation, "名称与类型库中的《${it.type.name}》精确匹配")
                }
            }
    }
}

/** 对一个问题的处置，再按候选展开成 [TypeResolution]。 */
private sealed interface Settlement {
    fun forCandidate(candidate: CandidateId): TypeResolution

    data class Placed(val type: RelationTypeId, val orientation: Orientation, val reason: String) : Settlement {
        override fun forCandidate(candidate: CandidateId): TypeResolution =
            TypeResolution.Resolved(candidate, type, orientation, reason)
    }

    data class Failed(val reason: String) : Settlement {
        override fun forCandidate(candidate: CandidateId): TypeResolution =
            TypeResolution.Unresolved(candidate, reason)
    }
}
