package com.zhiying.domain.library

/** 书的稳定身份；不随分析任务或导入修订改变。 */
@JvmInline
value class BookId(val value: String) {
    init {
        require(value.isNotBlank()) { "书 ID 不能为空" }
    }
}

/** 章节的稳定身份；与阅读顺序分开，章节重排不改变已有引用的含义。 */
@JvmInline
value class ChapterId(val value: String) {
    init {
        require(value.isNotBlank()) { "章节 ID 不能为空" }
    }
}

/** 证据的稳定身份。 */
@JvmInline
value class EvidenceId(val value: String) {
    init {
        require(value.isNotBlank()) { "证据 ID 不能为空" }
    }
}

/** 章节正文的修订号；正文修订后递增，旧区间据此识别为过期，不会被误读成新正文的另一段。 */
@JvmInline
value class TextRevision(val number: Int) {
    init {
        require(number >= 1) { "正文修订号从 1 开始" }
    }
}

/** 源文件在存储中的不可变引用（如内容摘要），不是文件系统路径。 */
@JvmInline
value class SourceFileRef(val value: String) {
    init {
        require(value.isNotBlank()) { "源文件引用不能为空" }
    }
}
