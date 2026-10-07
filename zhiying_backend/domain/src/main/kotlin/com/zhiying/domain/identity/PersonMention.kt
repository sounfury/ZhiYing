package com.zhiying.domain.identity

import com.zhiying.domain.library.ChapterId

/**
 * 章内一次人物提及：本章提到了谁、原文怎么称呼、称呼归属的依据。
 *
 * 包括无姓名但可稳定识别的具体人物；不要求覆盖每个代词。
 * [stableKind] 为 null 表示仅在本次上下文成立的指代，例如某位说话者口中的"父亲""那个老人"。
 */
data class PersonMention(
    val id: MentionId,
    val person: LocalPersonRef,
    val name: String,
    val stableKind: NameKind?,
    val basis: String,
) {
    init {
        require(name.isNotBlank() && name == name.trim()) { "称呼不能为空，且须去除首尾空白" }
        require(basis.isNotBlank()) { "提及必须说明称呼归属的依据" }
    }

    /** 提及所在章节。 */
    val chapterId: ChapterId get() = person.chapterId

    /** 把本次提及转成人名册的名称绑定；上下文指代不进入全书绑定，返回 null。 */
    fun toBinding(personId: PersonId): NameBinding? =
        stableKind?.let { kind -> NameBinding(name, personId, kind, chapterId, basis) }
}
