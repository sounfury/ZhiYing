package com.zhiying.domain.identity

import com.zhiying.domain.library.ChapterId

/** 名称种类。 */
enum class NameKind {
    /** 正式姓名。 */
    FORMAL,

    /** 有原文依据的外号、字号、稳定称谓等别名。 */
    ALIAS,

    /** 无姓名人物在原文中可稳定识别的称呼，如"摆渡老人的妻子"。 */
    STABLE_APPELLATION,
}

/**
 * 已成立的名称绑定：某个名称稳定指向某个人物，附来源章节与归属依据。
 *
 * 名称不唯一——不同人物可以绑定同一个名称，身份只由人物 ID 决定。
 */
data class NameBinding(
    val name: String,
    val personId: PersonId,
    val kind: NameKind,
    val sourceChapter: ChapterId,
    val basis: String,
) {
    init {
        require(name.isNotBlank() && name == name.trim()) { "名称不能为空，且须去除首尾空白" }
        require(basis.isNotBlank()) { "名称归属必须说明依据" }
    }
}
