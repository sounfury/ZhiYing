// 书库仓储的 SQLite 实现：书、章节概要与章节正文的读写；保存在同一事务内完成。
package com.zhiying.infrastructure.persistence.library

import com.zhiying.application.library.BookOverview
import com.zhiying.application.library.BookRepository
import com.zhiying.application.library.ChapterRecord
import com.zhiying.domain.library.Book
import com.zhiying.domain.library.BookId
import com.zhiying.domain.library.BookProfile
import com.zhiying.domain.library.Chapter
import com.zhiying.domain.library.ChapterId
import com.zhiying.domain.library.ChapterInclusion
import com.zhiying.domain.library.ChapterOutline
import com.zhiying.domain.library.ExclusionReason
import com.zhiying.domain.library.SourceFileRef
import com.zhiying.domain.library.TextRevision
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.stereotype.Repository
import org.springframework.transaction.annotation.Transactional
import java.sql.ResultSet
import java.time.Instant

/** 基于 JdbcClient 的书库仓储。 */
@Repository
class SqliteBookRepository(private val jdbc: JdbcClient) : BookRepository {

    private companion object {
        /** 章节概要列；查询时给 chapters 表起别名 c。 */
        const val OUTLINE_COLUMNS = "c.id, c.book_id, c.ord, c.title, c.word_count, c.source_href, c.included, c.exclusion_reason"
    }

    /** 先写书，再逐章写概要与正文；事务保证要么全部保存要么都不保存。 */
    @Transactional
    override fun save(overview: BookOverview, chapters: List<ChapterRecord>) {
        val book = overview.book
        val p = overview.profile
        jdbc.sql(
            """INSERT INTO books (id, title, author, source_ref, original_name, imported_at, total_chapters,
               analysis_chapters, total_words, max_chapter_words, median_chapter_words)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        ).params(
            listOf(
                book.id.value, book.title, book.author, book.source.value, overview.originalName,
                overview.importedAt.toString(), p.totalChapters, p.analysisChapters, p.totalWords,
                p.maxChapterWords, p.medianChapterWords,
            ),
        ).update()
        for ((outline, text) in chapters) {
            val reason = (outline.inclusion as? ChapterInclusion.Excluded)?.reason?.name
            jdbc.sql(
                """INSERT INTO chapters (id, book_id, ord, title, word_count, source_href, included, exclusion_reason)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            ).params(
                listOf(
                    outline.id.value, outline.bookId.value, outline.order, outline.title, outline.wordCount,
                    outline.sourceHref, if (outline.inclusion.included) 1 else 0, reason,
                ),
            ).update()
            jdbc.sql("INSERT INTO chapter_texts (chapter_id, revision, text) VALUES (?, 1, ?)")
                .params(outline.id.value, text).update()
        }
    }

    /** 按导入时间倒序列出全部书。 */
    override fun listBooks(): List<BookOverview> =
        jdbc.sql("SELECT * FROM books ORDER BY imported_at DESC, rowid DESC").query { rs, _ -> overviewOf(rs) }.list()

    /** 按 ID 取书概览。 */
    override fun findBook(id: BookId): BookOverview? =
        jdbc.sql("SELECT * FROM books WHERE id = ?").param(id.value).query { rs, _ -> overviewOf(rs) }.optional().orElse(null)

    /** 按阅读顺序列出章节概要。 */
    override fun listChapters(bookId: BookId): List<ChapterOutline> =
        jdbc.sql("SELECT $OUTLINE_COLUMNS FROM chapters c WHERE c.book_id = ? ORDER BY c.ord")
            .param(bookId.value).query { rs, _ -> outlineOf(rs) }.list()

    /** 按章节 ID 读取章节（含正文）。 */
    override fun findChapter(id: ChapterId): Chapter? =
        jdbc.sql(
            "SELECT $OUTLINE_COLUMNS, t.revision, t.text FROM chapters c JOIN chapter_texts t ON t.chapter_id = c.id WHERE c.id = ?",
        ).param(id.value).query { rs, _ -> chapterOf(rs) }.optional().orElse(null)

    /** 按书与阅读序号读取章节（含正文）。 */
    override fun findChapter(bookId: BookId, order: Int): Chapter? =
        jdbc.sql(
            """SELECT $OUTLINE_COLUMNS, t.revision, t.text FROM chapters c JOIN chapter_texts t ON t.chapter_id = c.id
               WHERE c.book_id = ? AND c.ord = ?""",
        ).params(bookId.value, order).query { rs, _ -> chapterOf(rs) }.optional().orElse(null)

    /** 当前行转书概览。 */
    private fun overviewOf(rs: ResultSet) = BookOverview(
        book = Book(BookId(rs.getString("id")), rs.getString("title"), rs.getString("author"), SourceFileRef(rs.getString("source_ref"))),
        originalName = rs.getString("original_name"),
        importedAt = Instant.parse(rs.getString("imported_at")),
        profile = BookProfile(
            rs.getInt("total_chapters"), rs.getInt("analysis_chapters"), rs.getInt("total_words"),
            rs.getInt("max_chapter_words"), rs.getInt("median_chapter_words"),
        ),
    )

    /** 当前行转章节概要。 */
    private fun outlineOf(rs: ResultSet) = ChapterOutline(
        id = ChapterId(rs.getString("id")),
        bookId = BookId(rs.getString("book_id")),
        order = rs.getInt("ord"),
        title = rs.getString("title"),
        wordCount = rs.getInt("word_count"),
        sourceHref = rs.getString("source_href"),
        inclusion = rs.getString("exclusion_reason")?.let { ChapterInclusion.Excluded(ExclusionReason.valueOf(it)) }
            ?: ChapterInclusion.Included,
    )

    /** 当前行（概要 + 正文）转领域章节。 */
    private fun chapterOf(rs: ResultSet): Chapter {
        val outline = outlineOf(rs)
        return Chapter(outline.id, outline.bookId, outline.order, outline.title, TextRevision(rs.getInt("revision")), rs.getString("text"))
    }
}
