// 书架条目的 SQLite 存储：命中只建条目，分叉原子保存新书、章抽取与 pending 指针。
package com.zhiying.infrastructure.persistence.library

import com.zhiying.application.analyze.run.ExtractionStore
import com.zhiying.application.analyze.run.StoredExtraction
import com.zhiying.application.library.BookOverview
import com.zhiying.application.library.BookRepository
import com.zhiying.application.library.ChapterRecord
import com.zhiying.application.library.ShelfItem
import com.zhiying.application.library.ShelfItemStore
import com.zhiying.domain.library.BookId
import com.zhiying.domain.library.SourceFileRef
import com.zhiying.infrastructure.persistence.analysis.toDomain
import com.zhiying.infrastructure.persistence.analysis.toRecord
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.stereotype.Repository
import org.springframework.transaction.support.TransactionTemplate
import java.sql.ResultSet
import java.time.Instant
import java.util.UUID

@Repository
class SqliteShelfItemStore(
    private val jdbc: JdbcClient,
    private val transactions: TransactionTemplate,
    private val books: BookRepository,
    private val extractions: ExtractionStore,
) : ShelfItemStore {
    override fun find(id: BookId): ShelfItem? =
        jdbc
            .sql("SELECT * FROM shelf_items WHERE id = ?")
            .param(id.value)
            .query { rs, _ -> itemOf(rs) }
            .optional()
            .orElse(null)

    override fun findExisting(
        userId: String,
        source: SourceFileRef,
    ): ShelfItem? =
        jdbc
            .sql(
                "SELECT s.* FROM shelf_items s JOIN books b ON b.id = s.book_id WHERE s.user_id = ? AND b.source_ref = ? ORDER BY s.created_at DESC LIMIT 1",
            ).params(userId, source.value)
            .query { rs, _ -> itemOf(rs) }
            .optional()
            .orElse(null)

    override fun candidates(
        source: SourceFileRef,
        importVersion: Int,
    ): List<BookId> =
        jdbc
            .sql(
                """SELECT b.id FROM books b JOIN published_revision p ON p.book_id = b.id
            WHERE b.source_ref = ? AND b.import_version = ? ORDER BY p.published_at DESC, b.id""",
            ).params(source.value, importVersion)
            .query { rs, _ -> BookId(rs.getString("id")) }
            .list()

    override fun add(item: ShelfItem) {
        jdbc
            .sql("INSERT INTO shelf_items (id, user_id, book_id, pending_book_id, original_name, created_at) VALUES (?, ?, ?, ?, ?, ?)")
            .params(
                listOf(
                    item.id.value,
                    item.userId,
                    item.bookId.value,
                    item.pendingBookId?.value,
                    item.originalName,
                    item.createdAt.toString(),
                ),
            ).update()
    }

    override fun referenceCount(bookId: BookId): Int =
        jdbc
            .sql(
                "SELECT COUNT(*) FROM shelf_items WHERE book_id = ? OR pending_book_id = ?",
            ).params(bookId.value, bookId.value)
            .query(Int::class.java)
            .single()

    override fun fork(
        item: ShelfItem,
        book: BookOverview,
        chapters: List<ChapterRecord>,
        extractions: List<StoredExtraction>,
        pending: Boolean,
    ) {
        transactions.executeWithoutResult {
            books.save(book, chapters, null)
            val oldOrder = books.listChapters(item.bookId).associate { it.id to it.order }
            val newChapters = chapters.associateBy { it.outline.order }
            for (stored in extractions) {
                val old = stored.extraction
                val target = newChapters.getValue(oldOrder.getValue(old.chapterId))
                val relocated = old.toRecord().copy(id = UUID.randomUUID().toString(), chapterId = target.outline.id.value).toDomain()
                this.extractions.save(book.book.id, stored.taskId, relocated, stored.warnings)
            }
            val column = if (pending) "pending_book_id" else "book_id"
            val reset = if (pending) "" else ", pending_book_id = NULL"
            jdbc.sql("UPDATE shelf_items SET $column = ?$reset WHERE id = ?").params(book.book.id.value, item.id.value).update()
        }
    }

    private fun itemOf(rs: ResultSet) =
        ShelfItem(
            BookId(rs.getString("id")),
            rs.getString("user_id"),
            BookId(rs.getString("book_id")),
            rs.getString("pending_book_id")?.let(::BookId),
            rs.getString("original_name"),
            Instant.parse(rs.getString("created_at")),
        )
}
