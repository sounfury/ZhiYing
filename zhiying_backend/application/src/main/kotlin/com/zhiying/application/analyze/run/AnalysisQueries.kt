// 分析查询用例：任务快照（运行中取内存，否则取最近一次持久化）、书的分析状态、某章的抽取结果。只读。
package com.zhiying.application.analyze.run

import com.zhiying.application.error.AppException
import com.zhiying.application.error.ErrorCode
import com.zhiying.application.graphquery.RevisionStore
import com.zhiying.application.library.ExampleBooks
import com.zhiying.application.library.LibraryQueries
import com.zhiying.application.library.ShelfItems
import com.zhiying.application.quota.UsageLedger
import com.zhiying.domain.library.BookId
import org.springframework.stereotype.Service

/** 分析任务与章抽取的只读查询；书或章不存在统一抛 NOT_FOUND。 */
@Service
class AnalysisQueries(
    private val library: LibraryQueries,
    private val runner: AnalysisRunner,
    private val tasks: AnalysisTaskStore,
    private val extractions: ExtractionStore,
    private val examples: ExampleBooks,
    private val revisions: RevisionStore,
    private val items: ShelfItems,
    private val ledger: UsageLedger,
) {
    /** 该书当前任务快照：有运行中的任务取其实时快照，否则取最近一次任务；从未分析过返回 null。书不存在抛 NOT_FOUND。 */
    fun currentTask(bookId: BookId): AnalysisTask? {
        val actualId = items.taskBookId(bookId)
        library.getBook(actualId)
        return (runner.activeTask(actualId) ?: tasks.latestForItem(actualId, bookId))?.copy(bookId = bookId)
    }

    /** 书的分析状态（书库列表用）：有运行中的任务（含单章重跑）一律为 ANALYZING，否则取最近一次整书任务的结果。 */
    fun bookStatus(bookId: BookId): BookAnalysisStatus {
        val item = items.get(bookId)
        val stored = if (currentTask(bookId) == null) BookAnalysisStatus.UPLOADED else tasks.bookStatus(item.taskBookId)
        if (runner.activeTask(item.taskBookId) != null) return stored.copy(state = BookAnalysisStatus.State.ANALYZING)
        if (stored.state != BookAnalysisStatus.State.UPLOADED) return stored
        val revision = revisions.findPublished(item.bookId) ?: return stored
        return stored.copy(state = BookAnalysisStatus.State.ANALYZED, chaptersDone = revision.analyzedChapters.mapNotNull { revision.chapterOrder[it] }.sorted())
    }

    /** 各条目本人累计模型用量；秒传且未自行分析的条目为全 0。 */
    fun bookUsage(bookIds: Collection<BookId>, userId: String?): Map<BookId, TaskUsage> =
        if (userId == null) bookIds.associateWith { TaskUsage() } else ledger.usageByItem(userId, bookIds)

    fun readChapter(bookId: BookId, order: Int) = library.readChapter(items.resultBookId(bookId), order)

    /** 某章（阅读序号）当前的抽取结果；该章尚未分析抛 NOT_FOUND。 */
    fun chapterExtraction(
        bookId: BookId,
        order: Int,
    ): StoredExtraction {
        val actualId = items.resultBookId(bookId)
        val chapter =
            library.listChapters(actualId).firstOrNull { it.order == order }
                ?: throw AppException(ErrorCode.NOT_FOUND, "章节不存在：${bookId.value} 第 $order 章")
        val stored =
            if (examples.slug(bookId) != null) {
                val revision = revisions.findPublished(actualId)
                if (revision == null || chapter.id !in revision.analyzedChapters) {
                    null
                } else {
                    extractions.findPublished(actualId, chapter.id)
                }
            } else {
                extractions.findCurrent(chapter.id)
            }
        return stored ?: throw AppException(ErrorCode.NOT_FOUND, "第 $order 章尚未分析")
    }
}
