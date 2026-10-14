// 按书删除数据的 SQLite 实现：跨书库、分析编排、结果版本三组表，在一个事务里删除。
package com.zhiying.infrastructure.persistence

import com.zhiying.application.removal.BookDataEraser
import com.zhiying.domain.library.BookId
import com.zhiying.domain.library.SourceFileRef
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.stereotype.Repository
import org.springframework.transaction.support.TransactionTemplate

/**
 * [BookDataEraser] 的 SQLite 实现。
 *
 * 分析与版本表不对书表建外键，须逐表按 book_id 删除；先删引用方再删被引用方（发布指针 → 版本、当前指针 → 抽取）。
 * 书表删除后章节与正文由外键级联删除。类型语义缓存与具体书无关，不删。
 */
@Repository
class SqliteBookDataEraser(
    private val jdbc: JdbcClient,
    private val transactions: TransactionTemplate,
) : BookDataEraser {

    private companion object {
        /** 分析数据的删除顺序；analysis_task_chapter 随 analysis_task 级联删除。 */
        val ANALYSIS_TABLES = listOf(
            "published_revision", "analysis_revision", "chapter_extraction_current", "chapter_extraction",
            "analysis_task", "book_analysis",
        )
    }

    override fun eraseAnalysis(bookId: BookId) {
        transactions.executeWithoutResult { deleteAnalysis(bookId) }
    }

    override fun eraseBook(bookId: BookId): SourceFileRef? = transactions.execute {
        if (references(bookId) > 0) return@execute null
        deleteAnalysis(bookId)
        val ref = jdbc.sql("SELECT source_ref FROM books WHERE id = ?").param(bookId.value)
            .query(String::class.java).optional().orElse(null)
        jdbc.sql("DELETE FROM books WHERE id = ?").param(bookId.value).update()
        ref?.takeIf {
            jdbc.sql("SELECT COUNT(*) FROM books WHERE source_ref = ?").param(it).query(Int::class.java).single() == 0
        }?.let(::SourceFileRef)
    }

    override fun eraseItem(itemId: BookId): List<SourceFileRef> = transactions.execute {
        val ids = jdbc.sql("SELECT book_id, pending_book_id FROM shelf_items WHERE id = ?").param(itemId.value)
            .query { rs, _ -> listOfNotNull(rs.getString("book_id"), rs.getString("pending_book_id")).map(::BookId) }
            .optional().orElse(emptyList())
        jdbc.sql("DELETE FROM shelf_items WHERE id = ?").param(itemId.value).update()
        ids.distinct().mapNotNull(::eraseBook).distinct()
    }

    private fun references(bookId: BookId): Int = jdbc.sql("SELECT COUNT(*) FROM shelf_items WHERE book_id = ? OR pending_book_id = ?")
        .params(bookId.value, bookId.value).query(Int::class.java).single()

    private fun deleteAnalysis(bookId: BookId) {
        ANALYSIS_TABLES.forEach { table -> jdbc.sql("DELETE FROM $table WHERE book_id = ?").param(bookId.value).update() }
    }
}
