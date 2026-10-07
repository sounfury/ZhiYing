// 书库仓储接口：应用层需要的书与章节读写能力，由基础设施用 SQLite 实现。
package com.zhiying.application.library

import com.zhiying.domain.library.Book
import com.zhiying.domain.library.BookId
import com.zhiying.domain.library.BookProfile
import com.zhiying.domain.library.Chapter
import com.zhiying.domain.library.ChapterId
import com.zhiying.domain.library.ChapterOutline
import com.zhiying.domain.library.SourceFileRef
import java.time.Instant

/**
 * 书的概览：书本身加导入信息与画像。
 *
 * 入参：[originalName] 上传时的文件名；[importedAt] 导入时间；[profile] 章数与字数画像。
 */
data class BookOverview(
    val book: Book,
    val originalName: String,
    val importedAt: Instant,
    val profile: BookProfile,
)

/** 一章的概要与正文，导入时整体保存。 */
data class ChapterRecord(val outline: ChapterOutline, val text: String)

/** 书库仓储：书与章节的持久化。 */
interface BookRepository {
    /** 在同一事务中保存书及其全部章节；任一失败则整体不保存。 */
    fun save(overview: BookOverview, chapters: List<ChapterRecord>)

    /** 按导入时间倒序列出全部书。 */
    fun listBooks(): List<BookOverview>

    /** 取书概览；不存在返回 null。 */
    fun findBook(id: BookId): BookOverview?

    /** 按阅读顺序列出某本书的章节概要（不含正文）。 */
    fun listChapters(bookId: BookId): List<ChapterOutline>

    /** 按章节 ID 读取章节（含正文）；不存在返回 null。 */
    fun findChapter(id: ChapterId): Chapter?

    /** 按书与阅读序号读取章节（含正文）；不存在返回 null。 */
    fun findChapter(bookId: BookId, order: Int): Chapter?
}

/** 源文件存储：按内容摘要保存导入的原始文件。 */
interface BookSourceStore {
    /** 保存源文件并返回其不可变引用（内容摘要）；相同内容重复保存不会重复占用空间。 */
    fun save(content: ByteArray): SourceFileRef
}
