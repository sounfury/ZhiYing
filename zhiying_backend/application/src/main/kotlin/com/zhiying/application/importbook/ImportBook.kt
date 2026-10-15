// 上传用例在任务登记锁内判定本人重复与可秒传结果；未命中时解析并事务保存书、条目和章节。
package com.zhiying.application.importbook

import com.zhiying.application.analyze.run.AnalysisMethod
import com.zhiying.application.analyze.run.AnalysisRunner
import com.zhiying.application.error.AppException
import com.zhiying.application.error.ErrorCode
import com.zhiying.application.graphquery.RevisionStore
import com.zhiying.application.library.BookOverview
import com.zhiying.application.library.BookRepository
import com.zhiying.application.library.BookSourceStore
import com.zhiying.application.library.ChapterRecord
import com.zhiying.application.library.ShelfItem
import com.zhiying.application.library.ShelfItemStore
import com.zhiying.application.library.ShelfItems
import com.zhiying.application.llm.ModelSettings
import com.zhiying.application.quota.QuotaUsage
import com.zhiying.domain.account.Account
import com.zhiying.domain.library.Book
import com.zhiying.domain.library.BookId
import com.zhiying.domain.library.BookProfile
import com.zhiying.domain.library.ChapterId
import com.zhiying.domain.library.ChapterInclusion
import com.zhiying.domain.library.ChapterOutline
import com.zhiying.domain.library.IMPORT_VERSION
import com.zhiying.domain.library.SourceFileRef
import org.springframework.stereotype.Service
import java.security.MessageDigest
import java.time.Instant
import java.util.UUID

data class ParsedChapter(
    val title: String,
    val text: String,
    val wordCount: Int,
    val sourceHref: String,
    val inclusion: ChapterInclusion,
)

data class ParsedBook(
    val title: String?,
    val author: String?,
    val chapters: List<ParsedChapter>,
    /** TXT 的分章方案 id；EPUB 为 null。 */
    val splitRule: String? = null,
)

/** 一种分章方案的试切结果：章数与开头、中间、结尾各几章的标题。 */
data class SplitPreview(
    val id: String,
    val name: String,
    val example: String,
    val chapterCount: Int,
    val beginning: List<String>,
    val middle: List<String>,
    val end: List<String>,
    val current: Boolean,
)

/** TXT 解析：[rule] 为 null 时自动选择分章方案；方案不存在抛 INVALID_ARGUMENT，无法解码或无有效章节抛 UNREADABLE_BOOK。 */
interface TxtParser {
    fun parse(content: ByteArray, rule: String? = null): ParsedBook

    /** 按全部方案试切，不落库。 */
    fun preview(content: ByteArray, currentRule: String): List<SplitPreview>
}

fun isTxt(fileName: String) = fileName.endsWith(".txt", ignoreCase = true)

interface EpubParser {
    fun parse(content: ByteArray): ParsedBook
}

data class ImportResult(
    val overview: BookOverview,
    val existing: Boolean = false,
    val reused: Boolean = false,
)

/** 导入与分叉共用的解析、建书步骤；保存由各用例显式执行。 */
@Service
class BookImporter(
    private val parser: EpubParser,
    private val txtParser: TxtParser,
) {
    /** 按扩展名选解析器；[rule] 只对 TXT 生效。 */
    fun parse(fileName: String, content: ByteArray, rule: String? = null): ParsedBook =
        if (isTxt(fileName)) txtParser.parse(content, rule) else parser.parse(content)

    fun preview(content: ByteArray, currentRule: String) = txtParser.preview(content, currentRule)

    fun prepare(
        fileName: String,
        source: SourceFileRef,
        parsed: ParsedBook,
    ): Pair<BookOverview, List<ChapterRecord>> {
        val bookId = BookId(UUID.randomUUID().toString())
        val title = parsed.title?.takeIf { it.isNotBlank() } ?: fileName.substringBeforeLast('.')
        val records =
            parsed.chapters.mapIndexed { index, c ->
                val outline =
                    ChapterOutline(
                        ChapterId(UUID.randomUUID().toString()),
                        bookId,
                        index + 1,
                        c.title,
                        c.wordCount,
                        c.sourceHref,
                        c.inclusion,
                    )
                ChapterRecord(outline, c.text)
            }
        return BookOverview(
            Book(bookId, title.trim(), parsed.author?.takeIf { it.isNotBlank() }, source, splitRule = parsed.splitRule),
            fileName,
            Instant.now(),
            BookProfile.of(records.map { it.outline }),
        ) to records
    }
}

@Service
class ImportBook(
    private val importer: BookImporter,
    private val sources: BookSourceStore,
    private val books: BookRepository,
    private val quota: QuotaUsage,
    private val items: ShelfItems,
    private val shelves: ShelfItemStore,
    private val revisions: RevisionStore,
    private val method: AnalysisMethod,
    private val runner: AnalysisRunner,
    private val models: ModelSettings,
) {
    fun import(
        fileName: String,
        content: ByteArray,
        user: Account,
    ): ImportResult =
        runner.withRegistrationLock {
            if (!fileName.endsWith(".epub", ignoreCase = true) && !isTxt(fileName)) {
                throw AppException(ErrorCode.INVALID_ARGUMENT, "只接受 .epub 或 .txt 文件")
            }
            val usage = quota.snapshot(user)
            // 重复上传不新增条目，仍受单文件大小限制。
            quota.requireAllowed(usage.copy(books = 0, isAdministrator = true).checkUpload(content.size.toLong()))
            val source = SourceFileRef(MessageDigest.getInstance("SHA-256").digest(content).joinToString("") { "%02x".format(it) })
            shelves.findExisting(user.id, source)?.let { return@withRegistrationLock ImportResult(items.overview(it.id), existing = true) }
            quota.requireAllowed(usage.checkUpload(content.size.toLong()))
            // TXT 秒传要按自动选出的分章方案匹配，所以先解析；EPUB 仍在未命中时才解析。
            val parsedTxt = if (isTxt(fileName)) importer.parse(fileName, content) else null
            val splitRule = parsedTxt?.splitRule
            val currentMethod = method.version(models.snapshot())
            val candidate =
                shelves.candidates(source, IMPORT_VERSION, splitRule).firstOrNull {
                    !runner.hasUnsettledTask(it) && revisions.findPublished(it)?.reusableFor(currentMethod) == true
                }
            if (candidate != null) {
                val item = ShelfItem(BookId(UUID.randomUUID().toString()), user.id, candidate, null, fileName, Instant.now())
                shelves.add(item)
                return@withRegistrationLock ImportResult(items.overview(item.id), reused = true)
            }
            val (overview, chapters) = importer.prepare(fileName, source, parsedTxt ?: importer.parse(fileName, content))
            sources.save(content)
            books.save(overview, chapters, user.id)
            ImportResult(overview)
        }
}
