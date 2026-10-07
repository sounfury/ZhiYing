// 分析查询用例：任务快照（运行中取内存，否则取最近一次持久化）、书的分析状态、某章的抽取结果。只读。
package com.zhiying.application.analyze.run

import com.zhiying.application.error.AppException
import com.zhiying.application.error.ErrorCode
import com.zhiying.application.library.LibraryQueries
import com.zhiying.domain.library.BookId
import org.springframework.stereotype.Service

/** 分析任务与章抽取的只读查询；书或章不存在统一抛 NOT_FOUND。 */
@Service
class AnalysisQueries(
    private val library: LibraryQueries,
    private val runner: AnalysisRunner,
    private val tasks: AnalysisTaskStore,
    private val extractions: ExtractionStore,
) {
    /** 该书当前任务快照：有运行中的任务取其实时快照，否则取最近一次任务；从未分析过返回 null。书不存在抛 NOT_FOUND。 */
    fun currentTask(bookId: BookId): AnalysisTask? {
        library.getBook(bookId)
        return runner.activeTask(bookId) ?: tasks.latest(bookId)
    }

    /** 书的分析状态（书库列表用）：有运行中的任务（含单章重跑）一律为 ANALYZING，否则取最近一次整书任务的结果。 */
    fun bookStatus(bookId: BookId): BookAnalysisStatus {
        val stored = tasks.bookStatus(bookId)
        return if (runner.activeTask(bookId) != null) stored.copy(state = BookAnalysisStatus.State.ANALYZING) else stored
    }

    /** 各书累计模型用量（整书分析与单章重跑合计，含失败与取消的任务）；无任务的书为全 0。 */
    fun bookUsage(bookIds: Collection<BookId>): Map<BookId, TaskUsage> = tasks.usageByBook(bookIds)

    /** 某章（阅读序号）当前的抽取结果；该章尚未分析抛 NOT_FOUND。 */
    fun chapterExtraction(bookId: BookId, order: Int): StoredExtraction {
        val chapter = library.listChapters(bookId).firstOrNull { it.order == order }
            ?: throw AppException(ErrorCode.NOT_FOUND, "章节不存在：${bookId.value} 第 $order 章")
        return extractions.findCurrent(chapter.id)
            ?: throw AppException(ErrorCode.NOT_FOUND, "第 $order 章尚未分析")
    }
}
