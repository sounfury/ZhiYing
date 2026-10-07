package com.zhiying.domain.identity

/** 性别：用于头像框配色；原文不明确时为未知，不猜测。 */
enum class Gender { MALE, FEMALE, UNKNOWN }

/** 重要度：用于区分节点大小。 */
enum class Importance { PROTAGONIST, SUPPORTING, MINOR }

/**
 * 书内人物身份。
 *
 * 人物 ID 独立于名称：补充正式名、增加别名都不改变身份及其关系归属。
 * 展示名与别名都由已成立的名称绑定投影而来，不另存第二份可写的名字列表。
 */
data class Person(
    val id: PersonId,
    val bindings: List<NameBinding>,
    val profile: String? = null,
    val gender: Gender = Gender.UNKNOWN,
    val importance: Importance? = null,
) {
    init {
        require(bindings.all { it.personId == id }) { "名称绑定必须指向本人物" }
        require(bindings.any { it.kind != NameKind.ALIAS }) { "人物至少要有正式名或稳定称呼" }
    }

    /** 图上主显示名：有正式名时用最早成立的正式名，否则用稳定称呼；绝不编造姓名。 */
    val displayName: String
        get() = (bindings.firstOrNull { it.kind == NameKind.FORMAL }
            ?: bindings.first { it.kind == NameKind.STABLE_APPELLATION }).name

    /** 别名：展示名以外的全部已成立名称，去重并保持成立顺序。 */
    val aliases: List<String>
        get() = bindings.map { it.name }.distinct().filterNot { it == displayName }

    /** 全部可用于检索候选的名称。 */
    val names: Set<String>
        get() = bindings.mapTo(linkedSetOf()) { it.name }

    /**
     * 追加一条名称绑定，返回新的人物快照。
     *
     * 命中已有人物时也要保存新别名；同名同种类的绑定已存在则原样返回，不重复记录。
     * 无姓名人物后来获得正式名时，展示名随之更新，人物 ID 与关系归属不变。
     */
    fun bind(binding: NameBinding): Person {
        require(binding.personId == id) { "不能把其他人物的名称绑定到本人物" }
        val exists = bindings.any { it.name == binding.name && it.kind == binding.kind }
        return if (exists) this else copy(bindings = bindings + binding)
    }

    /**
     * 用读章时的身份主张补全资料（简介、性别、重要度），返回新快照。
     *
     * 只补空缺，不覆盖已有内容；没有主张时原样返回。
     */
    fun fillDetails(claim: IdentityClaim?): Person = if (claim == null) this else copy(
        profile = profile ?: claim.profile?.takeIf { it.isNotBlank() },
        gender = if (gender == Gender.UNKNOWN) claim.gender else gender,
        importance = importance ?: claim.importance,
    )

    /**
     * 用全书简介覆盖简介，返回新快照；简介不能为空白，首次出场章的简介会被替换。
     */
    fun withProfile(text: String): Person {
        require(text.isNotBlank()) { "全书简介不能为空" }
        return copy(profile = text.trim())
    }

    /**
     * 并入另一个被判定为同一人的人物，返回合并后的新快照（身份保持为本人物）。
     *
     * 对方的全部名称绑定改归本人物并去重；资料只补空缺，不覆盖已有内容。
     */
    fun absorb(other: Person): Person {
        val merged = other.bindings.map { it.copy(personId = id) }.fold(this) { acc, binding -> acc.bind(binding) }
        return merged.copy(
            profile = profile ?: other.profile,
            gender = if (gender == Gender.UNKNOWN) other.gender else gender,
            importance = importance ?: other.importance,
        )
    }
}
