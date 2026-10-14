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
)

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
) {
    fun prepare(
        fileName: String,
        content: ByteArray,
        source: SourceFileRef,
    ): Pair<BookOverview, List<ChapterRecord>> {
        val parsed = parser.parse(content)
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
            Book(bookId, title.trim(), parsed.author?.takeIf { it.isNotBlank() }, source),
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
            if (!fileName.endsWith(".epub", ignoreCase = true)) {
                throw AppException(ErrorCode.INVALID_ARGUMENT, "只接受 .epub 文件")
            }
            val usage = quota.snapshot(user)
            // 重复上传不新增条目，仍受单文件大小限制。
            quota.requireAllowed(usage.copy(books = 0, isAdministrator = true).checkUpload(content.size.toLong()))
            val source = SourceFileRef(MessageDigest.getInstance("SHA-256").digest(content).joinToString("") { "%02x".format(it) })
            shelves.findExisting(user.id, source)?.let { return@withRegistrationLock ImportResult(items.overview(it.id), existing = true) }
            quota.requireAllowed(usage.checkUpload(content.size.toLong()))
            val currentMethod = method.version(models.snapshot())
            val candidate =
                shelves.candidates(source, IMPORT_VERSION).firstOrNull {
                    !runner.hasUnsettledTask(it) && revisions.findPublished(it)?.reusableFor(currentMethod) == true
                }
            if (candidate != null) {
                val item = ShelfItem(BookId(UUID.randomUUID().toString()), user.id, candidate, null, fileName, Instant.now())
                shelves.add(item)
                return@withRegistrationLock ImportResult(items.overview(item.id), reused = true)
            }
            val (overview, chapters) = importer.prepare(fileName, content, source)
            sources.save(content)
            books.save(overview, chapters, user.id)
            ImportResult(overview)
        }
}
