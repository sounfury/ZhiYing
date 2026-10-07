package com.zhiying.domain.identity

/**
 * 章 Agent 读章时对某个局部人物的身份主张：他就是已有的某人，或是新出现的人物。
 *
 * 主张只是输入；程序对照名称候选决定直接采用，还是交给针对真正歧义的身份判断。
 * [profile]、[gender]、[importance] 是读章时顺带得到的人物资料，原文不明确时保持空 / 未知，不猜测。
 */
data class IdentityClaim(
    val person: LocalPersonRef,
    val existing: PersonId?,
    val basis: String,
    val profile: String? = null,
    val gender: Gender = Gender.UNKNOWN,
    val importance: Importance? = null,
) {
    init {
        require(basis.isNotBlank()) { "身份主张必须说明理由" }
    }

    /** 是否主张为新出现的人物。 */
    val claimsNewPerson: Boolean get() = existing == null
}
