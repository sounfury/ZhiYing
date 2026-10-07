// 导入书用例：解析 EPUB → 保存源文件 → 在一个事务中保存书与章节；解析与存储能力由基础设施实现。
package com.zhiying.application.importbook

import com.zhiying.application.error.AppException
import com.zhiying.application.error.ErrorCode
import com.zhiying.application.library.BookOverview
import com.zhiying.application.library.BookRepository
import com.zhiying.application.library.BookSourceStore
import com.zhiying.application.library.ChapterRecord
import com.zhiying.domain.library.Book
import com.zhiying.domain.library.BookId
import com.zhiying.domain.library.BookProfile
import com.zhiying.domain.library.ChapterId
import com.zhiying.domain.library.ChapterInclusion
import com.zhiying.domain.library.ChapterOutline
import org.springframework.stereotype.Service
import java.time.Instant
import java.util.UUID

/**
 * 解析出的一章。
 *
 * 入参：[text] 清洗后的正文；[wordCount] 字数；[sourceHref] 章节来自 EPUB 内的哪个文件；[inclusion] 是否参与分析及原因。
 */
data class ParsedChapter(
    val title: String,
    val text: String,
    val wordCount: Int,
    val sourceHref: String,
    val inclusion: ChapterInclusion,
)

/** 解析出的书：元数据与按阅读顺序排列的章节。 */
data class ParsedBook(val title: String?, val author: String?, val chapters: List<ParsedChapter>)

/** EPUB 解析能力。 */
interface EpubParser {
    /**
     * 解析 EPUB 内容。
     *
     * 入参：[content] 文件字节。出参：解析结果。无法解析或没有可分析章节时抛 [ErrorCode.UNREADABLE_BOOK]。
     */
    fun parse(content: ByteArray): ParsedBook
}

/** 导入书用例。 */
@Service
class ImportBook(
    private val parser: EpubParser,
    private val sources: BookSourceStore,
    private val books: BookRepository,
) {
    /**
     * 导入一本 EPUB。
     *
     * 入参：[fileName] 上传文件名（须以 .epub 结尾）；[content] 文件字节。出参：新书概览。
     * 文件名不合法抛 INVALID_ARGUMENT；解析失败抛 UNREADABLE_BOOK。
     */
    fun import(fileName: String, content: ByteArray): BookOverview {
        if (!fileName.endsWith(".epub", ignoreCase = true)) {
            throw AppException(ErrorCode.INVALID_ARGUMENT, "只接受 .epub 文件")
        }
        // 1. 解析（纯计算，失败则什么都不落地）
        val parsed = parser.parse(content)
        // 2. 保存源文件（副作用：写文件）
        val source = sources.save(content)
        // 3. 组装并保存书与章节（副作用：数据库事务）
        val bookId = BookId(UUID.randomUUID().toString())
        val title = parsed.title?.takeIf { it.isNotBlank() } ?: fileName.substringBeforeLast('.')
        val records = parsed.chapters.mapIndexed { index, c ->
            val outline = ChapterOutline(
                ChapterId(UUID.randomUUID().toString()), bookId, index + 1, c.title, c.wordCount, c.sourceHref, c.inclusion,
            )
            ChapterRecord(outline, c.text)
        }
        val overview = BookOverview(
            book = Book(bookId, title.trim(), parsed.author?.takeIf { it.isNotBlank() }, source),
            originalName = fileName,
            importedAt = Instant.now(),
            profile = BookProfile.of(records.map { it.outline }),
        )
        books.save(overview, records)
        return overview
    }
}
