// TXT 分章方案的预览与改选：预览只试切不落库；改选从源文件按新方案导入新书并切换条目，等同「清空分析 + 换方案」。
package com.zhiying.application.importbook

import com.zhiying.application.analyze.run.AnalysisRunner
import com.zhiying.application.error.AppException
import com.zhiying.application.error.ErrorCode
import com.zhiying.application.library.BookRepository
import com.zhiying.application.library.BookSourceStore
import com.zhiying.application.library.ExampleBooks
import com.zhiying.application.library.ShelfItemStore
import com.zhiying.application.library.ShelfItems
import com.zhiying.application.removal.BookDataEraser
import com.zhiying.domain.library.Book
import com.zhiying.domain.library.BookId
import org.springframework.stereotype.Service

@Service
class ResplitBook(
    private val items: ShelfItems,
    private val shelves: ShelfItemStore,
    private val books: BookRepository,
    private val sources: BookSourceStore,
    private val importer: BookImporter,
    private val runner: AnalysisRunner,
    private val eraser: BookDataEraser,
    private val examples: ExampleBooks,
) {
    /** 对当前结果书的源文件跑全部方案；不是 TXT 抛 INVALID_ARGUMENT。 */
    fun preview(itemId: BookId): List<SplitPreview> {
        val book = txtBook(items.resultBookId(itemId))
        return importer.preview(sources.read(book.source), book.splitRule!!)
    }

    /**
     * 改选分章方案：读源文件 → 按新方案解析 → 新书与条目切换在同一事务 → 回收不再被引用的旧书。
     * 方案相同且无进行中的分叉时不做任何事；有运行中任务抛 ANALYSIS_ALREADY_RUNNING。
     */
    fun resplit(
        itemId: BookId,
        rule: String,
    ) {
        examples.requireRemovable(itemId)
        runner.withRegistrationLock {
            val item = items.get(itemId)
            runner.requireIdle(item.bookId)
            runner.requireIdle(item.taskBookId)
            val current = txtBook(item.bookId)
            if (current.splitRule == rule && item.pendingBookId == null) return@withRegistrationLock
            val parsed = importer.parse(item.originalName, sources.read(current.source), rule)
            val (book, chapters) = importer.prepare(item.originalName, current.source, parsed)
            shelves.fork(item, book, chapters, emptyList(), pending = false)
            listOfNotNull(item.bookId, item.pendingBookId)
                .distinct()
                .forEach { old -> runner.whileIdle(old) { eraser.eraseBook(old) }?.let(sources::delete) }
        }
    }

    private fun txtBook(bookId: BookId): Book {
        val book = books.findBook(bookId)?.book ?: throw AppException(ErrorCode.NOT_FOUND)
        if (book.splitRule == null) throw AppException(ErrorCode.INVALID_ARGUMENT, "只有 TXT 书可以换分章方案")
        return book
    }
}
