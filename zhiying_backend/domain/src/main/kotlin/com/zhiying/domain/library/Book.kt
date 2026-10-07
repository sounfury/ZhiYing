package com.zhiying.domain.library

/** 一本已导入的书；只描述书本身，不携带分析任务的运行状态。 */
data class Book(
    val id: BookId,
    val title: String,
    val author: String?,
    val source: SourceFileRef,
) {
    init {
        require(title.isNotBlank()) { "书名不能为空" }
    }
}
