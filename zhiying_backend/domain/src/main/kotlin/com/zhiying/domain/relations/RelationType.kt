package com.zhiying.domain.relations

import com.zhiying.domain.identity.PersonId

/** 关系硬度：只决定展示优先级与折叠规则，不表示判断可信度。 */
enum class Hardness {
    /** 硬关系，如夫妻、亲子、师徒：并列展示，互不覆盖。 */
    HARD,

    /** 中关系，如主仆、上下级、同门：可并存，展示次于硬关系。 */
    MEDIUM,

    /** 软关系，如朋友、相识：只作兜底，已有硬 / 中关系时默认折叠。 */
    SOFT;

    /** 是否属于硬 / 中关系。 */
    val strong: Boolean get() = this != SOFT
}

/** 类型来源：内置高频类型，或为本书登记的新类型。 */
enum class TypeOrigin { BUILT_IN, BOOK }

/** 关系方向。 */
sealed interface Direction {
    /** 无向关系：两端对等，端点顺序无意义。 */
    data object Undirected : Direction

    /** 有向关系：源端承担 [sourceRole]，目标端承担 [targetRole]，如"父亲 → 子女"。 */
    data class Directed(val sourceRole: String, val targetRole: String) : Direction {
        init {
            require(sourceRole.isNotBlank() && targetRole.isNotBlank()) { "有向关系必须给出两端角色" }
        }
    }
}

/**
 * 半开放类型库中的一种关系类型。
 *
 * 类型是数据而不是枚举：内置高频类型之外，罕见但重要的关系可以登记为本书新类型。
 */
data class RelationType(
    val id: RelationTypeId,
    val name: String,
    val definition: String,
    val hardness: Hardness,
    val direction: Direction,
    val synonyms: Set<String> = emptySet(),
    val origin: TypeOrigin = TypeOrigin.BUILT_IN,
    val reverseNames: Set<String> = emptySet(),
) {
    init {
        require(allNames.all { it.isNotBlank() && it == it.trim() }) { "类型名称不能为空，且须去除首尾空白" }
        require(definition.isNotBlank()) { "关系类型必须有定义" }
        require(reverseNames.isEmpty() || direction is Direction.Directed) { "只有有向关系才有反向称呼" }
    }

    /** 该类型的全部名称：正式名 + 同义名。名称表示"源端承担源角色"，如"甲是乙的父亲"。 */
    val names: Set<String> get() = synonyms + name

    /** 反向称呼：从目标端角度称呼同一事实，如"子女"之于"亲子"；命中时端点需对调。 */
    val allNames: Set<String> get() = names + reverseNames

    /**
     * 按方向规则生成规范关系键。
     *
     * 无向关系把两端按 ID 排序；有向关系保持 [source] 承担源角色的顺序，不能一律排序。
     * 两端是同一人物（例如合并之后）时返回 null：这样的记录需要重新处理，不能出图。
     */
    fun keyFor(source: PersonId, target: PersonId): RelationKey? {
        if (source == target) return null
        val swap = direction == Direction.Undirected && source.value > target.value
        return if (swap) RelationKey(target, source, id) else RelationKey(source, target, id)
    }
}
