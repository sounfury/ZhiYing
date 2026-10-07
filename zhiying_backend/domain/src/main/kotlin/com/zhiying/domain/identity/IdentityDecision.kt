package com.zhiying.domain.identity

/** 身份判断的来源。 */
enum class DecisionSource {
    /** 章 Agent 读章时的判断。 */
    CHAPTER_READING,

    /** 针对真正歧义做的有限判断。 */
    TARGETED_JUDGMENT,
}

/**
 * 对若干人物是否同一人的判断，保留依据与来源。
 *
 * 候选组不等于合并组：名称相似只产生候选，只有 [SamePerson] 结论才会合并；
 * 信息不足时用 [Undecided] 保持各自独立，不要求用户处理。
 */
sealed interface IdentityDecision {
    /** 结论涉及的人物，至少两人。 */
    val persons: Set<PersonId>

    /** 判断依据。 */
    val basis: String

    /** 判断来源。 */
    val source: DecisionSource

    /** 这些人物是同一个人。 */
    data class SamePerson(
        override val persons: Set<PersonId>,
        override val basis: String,
        override val source: DecisionSource,
    ) : IdentityDecision {
        init {
            requireWellFormed(persons, basis)
        }
    }

    /** 这些人物彼此不同。 */
    data class DistinctPersons(
        override val persons: Set<PersonId>,
        override val basis: String,
        override val source: DecisionSource,
    ) : IdentityDecision {
        init {
            requireWellFormed(persons, basis)
        }
    }

    /** 依据不足，暂时保持各自独立并记录疑点。 */
    data class Undecided(
        override val persons: Set<PersonId>,
        override val basis: String,
        override val source: DecisionSource,
    ) : IdentityDecision {
        init {
            requireWellFormed(persons, basis)
        }
    }
}

/** 校验身份结论至少涉及两人且说明了依据。 */
private fun requireWellFormed(persons: Set<PersonId>, basis: String) {
    require(persons.size >= 2) { "身份结论至少涉及两个人物" }
    require(basis.isNotBlank()) { "身份结论必须说明依据" }
}
