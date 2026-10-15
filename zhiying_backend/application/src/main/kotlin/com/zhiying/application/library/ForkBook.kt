// 共享书写入前重新导入源文件并复制当前章抽取；首次发布前保留原书指针。
package com.zhiying.application.library

import com.zhiying.application.analyze.run.ExtractionStore
import com.zhiying.application.importbook.BookImporter
import com.zhiying.domain.library.BookId
import org.springframework.stereotype.Service

@Service
class ForkBook(
    private val items: ShelfItems,
    private val shelves: ShelfItemStore,
    private val books: BookRepository,
    private val sources: BookSourceStore,
    private val importer: BookImporter,
    private val extractions: ExtractionStore,
) {
    /** 调用方持有任务登记锁，并已确认当前书与 pending 书均空闲。 */
    fun forWrite(
        itemId: BookId,
        clear: Boolean = false,
    ): BookId {
        val item = items.get(itemId)
        if (!clear && item.pendingBookId != null) return item.pendingBookId
        if (shelves.referenceCount(item.bookId) <= 1 && item.pendingBookId == null) return item.bookId
        val current = requireNotNull(books.findBook(item.bookId)).book
        // TXT 沿用当前分章方案，章序才能与被复制的章抽取对上
        val parsed = importer.parse(item.originalName, sources.read(current.source), current.splitRule)
        val (book, chapters) = importer.prepare(item.originalName, current.source, parsed)
        val copied = if (clear) emptyList() else extractions.listCurrent(item.bookId)
        shelves.fork(item, book, chapters, copied, pending = !clear)
        return book.book.id
    }
}
