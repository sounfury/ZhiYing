package com.zhiying.domain.graph

import com.zhiying.domain.affiliations.GroupId
import com.zhiying.domain.identity.PersonId

/** 分区的来源。 */
sealed interface PartitionBasis {
    /** 来自已成立的团体事实。 */
    data class Group(val group: GroupId) : PartitionBasis

    /** 为了摆图由算法推断的分区（如"第 N 阶段"）；落进这个块不证明此人属于某个团体。 */
    data class Inferred(val label: String) : PartitionBasis {
        init {
            require(label.isNotBlank()) { "推断分区必须有名称" }
        }
    }
}

/** 当前图的一个分块：显式团体与算法推断分区可区分。 */
data class LayoutPartition(
    val basis: PartitionBasis,
    val members: Set<PersonId>,
) {
    init {
        require(members.isNotEmpty()) { "分区至少包含一个人物" }
    }

    /** 是否来自算法推断而非团体事实。 */
    val inferred: Boolean get() = basis is PartitionBasis.Inferred
}
