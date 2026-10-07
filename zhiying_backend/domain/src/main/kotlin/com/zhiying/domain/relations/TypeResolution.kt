package com.zhiying.domain.relations

/** 候选的观察顺序与类型规范方向的对应关系。 */
enum class Orientation {
    /** 观察到的 source → target 就是类型定义的方向。 */
    AS_OBSERVED,

    /** 需要对调两端，例如把"乙是甲的孩子"归入"父亲"类型时。 */
    REVERSED;

    /** 按本对应关系给出规范的 (源端, 目标端)。 */
    fun <T> apply(source: T, target: T): Pair<T, T> =
        if (this == AS_OBSERVED) source to target else target to source
}

/** 类型归一结论：回答"这条候选属于什么关系、方向如何对应"，不回答"原文是否证明它成立"。 */
sealed interface TypeResolution {
    /** 被归一的候选。 */
    val candidate: CandidateId

    /** 归入类型库中的某个类型（可能是刚登记的本书新类型）。 */
    data class Resolved(
        override val candidate: CandidateId,
        val type: RelationTypeId,
        val orientation: Orientation,
        val basis: String,
    ) : TypeResolution {
        init {
            require(basis.isNotBlank()) { "类型归一必须说明理由" }
        }
    }

    /** 暂未归一：保留原文描述，不进入关系事实。 */
    data class Unresolved(
        override val candidate: CandidateId,
        val reason: String,
    ) : TypeResolution {
        init {
            require(reason.isNotBlank()) { "未归一必须说明原因" }
        }
    }
}
