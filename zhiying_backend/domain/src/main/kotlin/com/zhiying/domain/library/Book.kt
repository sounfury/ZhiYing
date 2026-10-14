// 已导入的书及导入规则版本，不携带分析任务状态。
package com.zhiying.domain.library

/** EPUB 切章、清洗或章节选择规则变化时递增。 */
const val IMPORT_VERSION = 1

/** 一本已导入的书；只描述书本身，不携带分析任务的运行状态。 */
data class Book(
    val id: BookId,
    val title: String,
    val author: String?,
    val source: SourceFileRef,
    val importVersion: Int = IMPORT_VERSION,
) {
    init {
        require(title.isNotBlank()) { "书名不能为空" }
    }
}
