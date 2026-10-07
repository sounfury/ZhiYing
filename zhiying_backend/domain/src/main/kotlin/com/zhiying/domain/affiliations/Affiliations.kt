package com.zhiying.domain.affiliations

import com.zhiying.domain.identity.PersonId
import com.zhiying.domain.library.EvidenceRef

/** 团体的稳定身份。 */
@JvmInline
value class GroupId(val value: String) {
    init {
        require(value.isNotBlank()) { "团体 ID 不能为空" }
    }
}

/**
 * 团体（势力）：学校、机构、家族、生活圈等因共同归属形成的人群聚合。
 *
 * 团体描述人物归属，与关系边正交："朋友"是边，学校、教会才是团体。
 */
data class AffiliationGroup(
    val id: GroupId,
    val name: String,
    val nameSource: EvidenceRef,
) {
    init {
        require(name.isNotBlank()) { "团体名称不能为空" }
    }
}

/** 某人物属于某团体的事实，附来源依据；一人可有多条归属。 */
data class Membership(
    val group: GroupId,
    val person: PersonId,
    val role: String?,
    val evidence: EvidenceRef,
)

/**
 * 本书的团体归属结果：团体及其成员事实。
 *
 * 成员只能引用已知团体，同一人物在同一团体只记一次；布局时的推断分区不写进这里。
 */
class Affiliations(
    val groups: List<AffiliationGroup>,
    val memberships: List<Membership>,
) {
    init {
        val known = groups.mapTo(mutableSetOf()) { it.id }
        require(known.size == groups.size) { "团体 ID 重复" }
        require(memberships.all { it.group in known }) { "成员引用了未知团体" }
        val pairs = memberships.map { it.group to it.person }
        require(pairs.size == pairs.toSet().size) { "同一人物在同一团体中重复登记" }
    }

    /** 某人物所属的全部团体（允许多归属）。 */
    fun groupsOf(person: PersonId): List<AffiliationGroup> {
        val ids = memberships.filter { it.person == person }.mapTo(mutableSetOf()) { it.group }
        return groups.filter { it.id in ids }
    }
}
