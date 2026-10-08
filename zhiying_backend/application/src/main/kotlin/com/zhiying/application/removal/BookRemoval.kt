// 删除书与清空分析用例（PRD §5.10）：确认没有运行中任务 → 在一个事务里删数据库记录 → 删除不再被引用的源文件。
package com.zhiying.application.removal

import com.zhiying.application.analyze.run.AnalysisRunner
import com.zhiying.application.library.BookSourceStore
import com.zhiying.application.library.LibraryQueries
import com.zhiying.domain.library.BookId
import com.zhiying.domain.library.SourceFileRef
import org.springframework.stereotype.Service

/** 按书删除持久化数据；每个方法在一个事务内完成，要么全删要么不删。 */
interface BookDataEraser {
    /** 删除该书全部分析数据：任务与各章进度、书的分析状态、章抽取、结果版本与发布指针。 */
    fun eraseAnalysis(bookId: BookId)

    /**
     * 删除该书全部分析数据以及书、章节与正文。
     * 出参：该书的源文件已不被其他书引用时返回其引用，由调用方删除文件；仍被引用返回 null。
     */
    fun eraseBook(bookId: BookId): SourceFileRef?
}

/** 删除书与清空分析。书不存在抛 NOT_FOUND；该书有运行中任务（含单章重跑）抛 ANALYSIS_ALREADY_RUNNING。 */
@Service
class BookRemoval(
    private val library: LibraryQueries,
    private val runner: AnalysisRunner,
    private val eraser: BookDataEraser,
    private val sources: BookSourceStore,
) {
    /** 清空分析：书与章节保留，书回到未分析；下次分析不再有可沿用的章抽取。 */
    fun clearAnalysis(bookId: BookId) {
        library.getBook(bookId)
        runner.whileIdle(bookId) { eraser.eraseAnalysis(bookId) }
    }

    /** 删除书：先在事务里删记录，提交后再删不再被引用的源文件（文件删除失败只留下孤立文件，不影响结果）。 */
    fun deleteBook(bookId: BookId) {
        library.getBook(bookId)
        val orphan = runner.whileIdle(bookId) { eraser.eraseBook(bookId) }
        orphan?.let(sources::delete)
    }
}
