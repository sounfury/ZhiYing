package com.zhiying.domain.identity

import com.zhiying.domain.library.ChapterId

/** 书内人物的稳定身份；独立于展示名，改名、补别名都不改变。 */
@JvmInline
value class PersonId(val value: String) {
    init {
        require(value.isNotBlank()) { "人物 ID 不能为空" }
    }
}

/** 章内一次人物提及的身份。 */
@JvmInline
value class MentionId(val value: String) {
    init {
        require(value.isNotBlank()) { "提及 ID 不能为空" }
    }
}

/** 章内局部人物引用（如章 Agent 分配的临时编号），只在所属章节的抽取内有效。 */
data class LocalPersonRef(val chapterId: ChapterId, val key: String) {
    init {
        require(key.isNotBlank()) { "局部人物编号不能为空" }
    }
}
