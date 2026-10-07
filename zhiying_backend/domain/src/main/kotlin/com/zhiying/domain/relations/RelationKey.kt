package com.zhiying.domain.relations

import com.zhiying.domain.identity.PersonId

/**
 * 关系事实的汇总键 (人物 A, 人物 B, 类型)。
 *
 * 只能由 [RelationType.keyFor] 创建，从而保证端点顺序已按类型方向归一：
 * 同一事实只有一个键，A → B 与 B → A 的有向关系不会被合成同一条。
 */
@ConsistentCopyVisibility
data class RelationKey internal constructor(
    val first: PersonId,
    val second: PersonId,
    val type: RelationTypeId,
)
