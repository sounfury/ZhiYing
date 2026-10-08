// 书籍接口：上传 EPUB、书目列表、书详情、章节列表、删除书、清空分析；字段名沿用前端现有的 snake_case 约定。
package com.zhiying.web.books

import com.fasterxml.jackson.annotation.JsonProperty
import com.zhiying.application.analyze.run.AnalysisQueries
import com.zhiying.application.analyze.run.BookAnalysisStatus
import com.zhiying.application.analyze.run.TaskUsage
import com.zhiying.application.importbook.ImportBook
import com.zhiying.application.library.BookOverview
import com.zhiying.application.library.LibraryQueries
import com.zhiying.application.removal.BookRemoval
import com.zhiying.domain.library.BookId
import com.zhiying.domain.library.ChapterInclusion
import com.zhiying.domain.library.ChapterOutline
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.DeleteMapping
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.ResponseStatus
import org.springframework.web.bind.annotation.RestController
import org.springframework.web.multipart.MultipartFile

/** 书籍 HTTP 接口。 */
@RestController
@RequestMapping("/api/books")
class BookController(
    private val importBook: ImportBook,
    private val library: LibraryQueries,
    private val analysis: AnalysisQueries,
    private val removal: BookRemoval,
) {

    /** 上传 EPUB（表单字段 file）：解析并保存，返回 201 与新书摘要；无法解析返回 UNREADABLE_BOOK。 */
    @PostMapping("/upload")
    fun upload(@RequestParam("file") file: MultipartFile): ResponseEntity<UploadResponse> {
        val overview = importBook.import(file.originalFilename.orEmpty(), file.bytes)
        return ResponseEntity.status(HttpStatus.CREATED).body(UploadResponse.from(overview))
    }

    /** 书目列表，新导入的在前。 */
    @GetMapping
    fun list(): BookListResponse {
        val books = library.listBooks()
        val usage = analysis.bookUsage(books.map { it.book.id })
        return BookListResponse(books.map { BookResponse.from(it, analysis.bookStatus(it.book.id), usage.getValue(it.book.id)) })
    }

    /** 单本书详情；不存在返回 NOT_FOUND。 */
    @GetMapping("/{bookId}")
    fun detail(@PathVariable bookId: String): BookResponse {
        val overview = library.getBook(BookId(bookId))
        val id = overview.book.id
        return BookResponse.from(overview, analysis.bookStatus(id), analysis.bookUsage(listOf(id)).getValue(id))
    }

    /** 章节列表（不含正文），含不参与分析的章节及原因；书不存在返回 NOT_FOUND。 */
    @GetMapping("/{bookId}/chapters")
    fun chapters(@PathVariable bookId: String) =
        ChapterListResponse(library.listChapters(BookId(bookId)).map(ChapterResponse::from))

    /** 删除书及其全部数据，返回 204；书不存在返回 NOT_FOUND，正在分析返回 ANALYSIS_ALREADY_RUNNING。 */
    @DeleteMapping("/{bookId}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun delete(@PathVariable bookId: String) = removal.deleteBook(BookId(bookId))

    /** 清空该书的分析数据（书与章节保留），返回 204；错误同删除书。 */
    @DeleteMapping("/{bookId}/analysis")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun clearAnalysis(@PathVariable bookId: String) = removal.clearAnalysis(BookId(bookId))
}

/** 上传结果。[analysisChapterCount] 为默认参与分析的章数。 */
data class UploadResponse(
    @JsonProperty("book_id") val bookId: String,
    val title: String,
    @JsonProperty("total_chapters") val totalChapters: Int,
    @JsonProperty("analysis_chapter_count") val analysisChapterCount: Int,
) {
    companion object {
        /** 由书概览构造。 */
        fun from(o: BookOverview) = UploadResponse(o.book.id.value, o.book.title, o.profile.totalChapters, o.profile.analysisChapters)
    }
}

/**
 * 书的 HTTP 表示（列表与详情共用）。
 *
 * [status] 取自最近一次整书分析：uploaded 未分析 / analyzing / analyzed / failed / cancelled；
 * [analysisProgress] 为最近一次整书任务中已有抽取与失败的章序号（reconcile_done 沿用旧字段名，等价于已分析完成）。
 * [tokenUsage] 为本书累计模型用量（整书分析与单章重跑合计，含失败与取消的任务）。
 * 单章重跑进行中也显示 analyzing。factions_stale 在新设计中不存在（团体随每个结果版本一并生成）。
 */
data class BookResponse(
    @JsonProperty("book_id") val bookId: String,
    val title: String,
    val author: String,
    @JsonProperty("source_file") val sourceFile: String,
    @JsonProperty("total_chapters") val totalChapters: Int,
    val status: String,
    @JsonProperty("created_at") val createdAt: String,
    @JsonProperty("total_words") val totalWords: Int,
    @JsonProperty("max_chapter_words") val maxChapterWords: Int,
    @JsonProperty("median_chapter_words") val medianChapterWords: Int,
    @JsonProperty("analysis_chapter_count") val analysisChapterCount: Int,
    @JsonProperty("analysis_progress") val analysisProgress: AnalysisProgressResponse,
    @JsonProperty("token_usage") val tokenUsage: TokenUsageResponse,
) {
    companion object {
        /** 由书概览与分析状态构造；作者缺失时给空串，与前端类型一致。 */
        fun from(o: BookOverview, analysis: BookAnalysisStatus, usage: TaskUsage) = BookResponse(
            o.book.id.value, o.book.title, o.book.author.orEmpty(), o.originalName, o.profile.totalChapters,
            analysis.state.name.lowercase(), o.importedAt.toString(), o.profile.totalWords, o.profile.maxChapterWords,
            o.profile.medianChapterWords, o.profile.analysisChapters,
            AnalysisProgressResponse(
                analysis.chaptersDone, analysis.chaptersFailed, analysis.state == BookAnalysisStatus.State.ANALYZED,
            ),
            TokenUsageResponse(usage.inputTokens, usage.outputTokens, usage.totalTokens, usage.requests),
        )
    }
}

/** 书的分析进度：已有抽取与失败的章序号。 */
data class AnalysisProgressResponse(
    @JsonProperty("chapters_done") val chaptersDone: List<Int>,
    @JsonProperty("chapters_failed") val chaptersFailed: List<Int>,
    @JsonProperty("reconcile_done") val reconcileDone: Boolean,
)

/** 本书累计模型用量。 */
data class TokenUsageResponse(
    @JsonProperty("input_tokens") val inputTokens: Long,
    @JsonProperty("output_tokens") val outputTokens: Long,
    @JsonProperty("total_tokens") val totalTokens: Long,
    @JsonProperty("llm_requests") val llmRequests: Long,
)

/** 书目列表响应。 */
data class BookListResponse(val books: List<BookResponse>)

/**
 * 章节概要的 HTTP 表示。
 *
 * [chapterId] 是从 1 开始的阅读序号（与旧接口一致）；[id] 是稳定的章节 ID；
 * 不参与分析时 [exclusionReason] 为原因代码、[exclusionLabel] 为中文说明，参与时两者为 null。
 */
data class ChapterResponse(
    @JsonProperty("chapter_id") val chapterId: Int,
    val id: String,
    val title: String,
    val order: Int,
    @JsonProperty("word_count") val wordCount: Int,
    @JsonProperty("include_in_analysis") val includeInAnalysis: Boolean,
    @JsonProperty("exclusion_reason") val exclusionReason: String?,
    @JsonProperty("exclusion_label") val exclusionLabel: String?,
    @JsonProperty("source_href") val sourceHref: String,
) {
    companion object {
        /** 由章节概要构造。 */
        fun from(c: ChapterOutline): ChapterResponse {
            val reason = (c.inclusion as? ChapterInclusion.Excluded)?.reason
            return ChapterResponse(
                c.order, c.id.value, c.title, c.order, c.wordCount, c.inclusion.included, reason?.name, reason?.label, c.sourceHref,
            )
        }
    }
}

/** 章节列表响应。 */
data class ChapterListResponse(val chapters: List<ChapterResponse>)
