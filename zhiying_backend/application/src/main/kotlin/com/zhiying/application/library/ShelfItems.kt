// 书架条目及存储端口：条目保存用户归属，结果与进行中的分叉任务分别解析到实际书。
package com.zhiying.application.library

import com.zhiying.application.analyze.run.StoredExtraction
import com.zhiying.application.error.AppException
import com.zhiying.application.error.ErrorCode
import com.zhiying.domain.library.BookId
import com.zhiying.domain.library.SourceFileRef
import org.springframework.stereotype.Service
import java.time.Instant

data class ShelfItem(
    val id: BookId,
    val userId: String,
    val bookId: BookId,
    val pendingBookId: BookId?,
    val originalName: String,
    val createdAt: Instant,
) {
    val taskBookId: BookId get() = pendingBookId ?: bookId
}

interface ShelfItemStore {
    fun find(id: BookId): ShelfItem?

    fun findExisting(
        userId: String,
        source: SourceFileRef,
    ): ShelfItem?

    /** 按最近发布时间倒序返回同文件、当前导入版本的已发布候选。 */
    fun candidates(
        source: SourceFileRef,
        importVersion: Int,
    ): List<BookId>

    fun add(item: ShelfItem)

    fun referenceCount(bookId: BookId): Int

    /** 新书、章节、复制抽取及条目指针在同一事务保存。 */
    fun fork(
        item: ShelfItem,
        book: BookOverview,
        chapters: List<ChapterRecord>,
        extractions: List<StoredExtraction>,
        pending: Boolean,
    )

}

@Service
class ShelfItems(
    private val store: ShelfItemStore,
    private val books: BookRepository,
) {
    fun get(id: BookId): ShelfItem = store.find(id) ?: throw AppException(ErrorCode.NOT_FOUND)

    fun resultBookId(id: BookId): BookId = get(id).bookId

    fun taskBookId(id: BookId): BookId = get(id).taskBookId

    fun listChapters(id: BookId) = books.listChapters(resultBookId(id))

    fun overview(id: BookId): BookOverview {
        val item = get(id)
        val book = books.findBook(item.bookId) ?: throw AppException(ErrorCode.NOT_FOUND)
        return book.copy(itemId = item.id, originalName = item.originalName, importedAt = item.createdAt)
    }
}
