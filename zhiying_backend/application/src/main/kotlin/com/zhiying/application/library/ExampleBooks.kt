// 示例书目录与访问规则：公开已发布版本，管理员维护分析，示例不能删除或清空。
package com.zhiying.application.library

import com.zhiying.application.analyze.run.BookAnalysisStatus
import com.zhiying.application.error.AppException
import com.zhiying.application.error.ErrorCode
import com.zhiying.application.graphquery.RevisionStore
import com.zhiying.domain.library.BookId
import org.springframework.stereotype.Service

/** 由基础设施装配；固定 slug 对应书 ID，调整书 ID 不改变宣传链接。 */
data class ExampleSettings(
    val books: Map<String, String>,
) {
    init {
        require(books.keys.all { it.matches(Regex("[a-z0-9]+(?:-[a-z0-9]+)*")) }) { "示例链接名称只能用小写字母、数字与连字符" }
        require(books.values.all { it.isNotBlank() } && books.values.distinct().size == books.size) { "示例书 ID 不能为空或重复" }
    }
}

@Service
class ExampleBooks(
    private val settings: ExampleSettings,
    private val revisions: RevisionStore,
) {
    fun slug(id: BookId): String? =
        settings.books.entries
            .firstOrNull { it.value == id.value }
            ?.key

    fun ids(): List<BookId> = settings.books.values.map(::BookId)

    fun isPublished(id: BookId): Boolean = slug(id) != null && revisions.publishedId(id) != null

    fun requireRemovable(id: BookId) {
        if (slug(id) != null) throw AppException(ErrorCode.READ_ONLY, "示例书不能删除或清空分析")
    }

    /** 维护任务不会改变访客看到的状态或已读章范围。 */
    fun publishedStatus(id: BookId): BookAnalysisStatus {
        val revision = revisions.findPublished(id) ?: throw AppException(ErrorCode.NOT_FOUND)
        return BookAnalysisStatus(
            state = BookAnalysisStatus.State.ANALYZED,
            chaptersDone = revision.analyzedChapters.mapNotNull { revision.chapterOrder[it] }.sorted(),
        )
    }
}
