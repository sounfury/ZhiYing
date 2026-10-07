// 图谱接口：GET /graph 返回当前已发布结果版本的关系图，GET /export 导出同一份图数据（JSON 文件）。
package com.zhiying.web.graph

import com.zhiying.application.error.AppException
import com.zhiying.application.error.ErrorCode
import com.zhiying.application.graphquery.ExportGraphData
import com.zhiying.application.graphquery.GetGraph
import com.zhiying.application.graphquery.GraphRequest
import com.zhiying.domain.graph.ChapterFocus
import com.zhiying.domain.graph.ChapterMode
import com.zhiying.domain.identity.PersonId
import com.zhiying.domain.library.BookId
import com.zhiying.domain.relations.Hardness
import com.zhiying.domain.relations.RelationTypeId
import org.springframework.http.ContentDisposition
import org.springframework.http.HttpHeaders
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController

/** 图谱与导出 HTTP 接口。 */
@RestController
@RequestMapping("/api/books/{bookId}")
class GraphController(private val getGraph: GetGraph, private val exportGraph: ExportGraphData) {

    /**
     * 关系图。
     *
     * 参数：min_appearance 最少出场章数（缺省用配置阈值）；focus 聚焦人物 ID；
     * predicate_filter 关系类型 ID，逗号分隔；category_filter 硬度（hard / medium / soft 或 硬关系 / 中关系 / 软关系），逗号分隔；
     * chapter 章节阅读序号（章节聚焦，从 1 起）；chapter_mode 为 single（只看本章）或 upto（前 N 章累计，缺省）。
     * 该书尚无已发布结果时返回空图（200），revision_id 为 null。
     */
    @GetMapping("/graph")
    fun graph(
        @PathVariable bookId: String,
        @RequestParam("min_appearance", required = false) minAppearance: Int?,
        @RequestParam("focus", required = false) focus: String?,
        @RequestParam("predicate_filter", required = false) predicateFilter: String?,
        @RequestParam("category_filter", required = false) categoryFilter: String?,
        @RequestParam("chapter", required = false) chapter: Int?,
        @RequestParam("chapter_mode", required = false) chapterMode: String?,
    ): GraphResponse = GraphResponse.from(
        getGraph.execute(BookId(bookId), request(minAppearance, focus, predicateFilter, categoryFilter, chapter, chapterMode)),
    )

    /** 导出 JSON（附件下载）；参数与 /graph 相同，内容与页面共用同一份图数据。 */
    @GetMapping("/export")
    fun export(
        @PathVariable bookId: String,
        @RequestParam("min_appearance", required = false) minAppearance: Int?,
        @RequestParam("focus", required = false) focus: String?,
        @RequestParam("predicate_filter", required = false) predicateFilter: String?,
        @RequestParam("category_filter", required = false) categoryFilter: String?,
        @RequestParam("chapter", required = false) chapter: Int?,
        @RequestParam("chapter_mode", required = false) chapterMode: String?,
    ): ResponseEntity<ExportResponse> {
        val export = exportGraph.execute(
            BookId(bookId),
            request(minAppearance, focus, predicateFilter, categoryFilter, chapter, chapterMode),
        )
        val safeId = bookId.replace(Regex("[^A-Za-z0-9._-]+"), "_").take(64).ifEmpty { "book" }
        val disposition = ContentDisposition.attachment().filename("zhiying-$safeId.json").build()
        return ResponseEntity.ok()
            .header(HttpHeaders.CONTENT_DISPOSITION, disposition.toString())
            .body(ExportResponse("zhiying-graph", 1, export.exportedAt.toString(), GraphResponse.from(export.graph)))
    }

    /** 把查询参数解析为应用层请求；硬度取值不认识时返回 INVALID_ARGUMENT。 */
    private fun request(
        minAppearance: Int?,
        focus: String?,
        predicateFilter: String?,
        categoryFilter: String?,
        chapter: Int?,
        chapterMode: String?,
    ) =
        GraphRequest(
            minAppearance = minAppearance,
            focus = focus?.takeIf { it.isNotBlank() }?.let { PersonId(it.trim()) },
            types = splitList(predicateFilter).mapTo(linkedSetOf()) { RelationTypeId(it) },
            hardness = splitList(categoryFilter).mapTo(linkedSetOf()) { hardnessOf(it) },
            chapterFocus = chapterFocusOf(chapter, chapterMode),
        )

    /** 章节聚焦参数：未给 chapter 时为空（给了 chapter_mode 也忽略）；章号小于 1 或模式非法返回 INVALID_ARGUMENT。 */
    private fun chapterFocusOf(chapter: Int?, mode: String?): ChapterFocus? {
        if (chapter == null) return null
        if (chapter < 1) throw AppException(ErrorCode.INVALID_ARGUMENT, "chapter 必须从 1 起: $chapter")
        val parsed = when (mode?.trim()?.lowercase()) {
            null, "", "upto" -> ChapterMode.UPTO
            "single" -> ChapterMode.SINGLE
            else -> throw AppException(ErrorCode.INVALID_ARGUMENT, "chapter_mode 只能是 single 或 upto: $mode")
        }
        return ChapterFocus(chapter, parsed)
    }

    /** 逗号分隔参数拆成非空项。 */
    private fun splitList(raw: String?): List<String> = raw.orEmpty().split(',').map { it.trim() }.filter { it.isNotEmpty() }

    /** 硬度参数：英文名或中文分类名。 */
    private fun hardnessOf(raw: String): Hardness = when (raw.lowercase().removeSuffix("关系")) {
        "hard", "硬" -> Hardness.HARD
        "medium", "中" -> Hardness.MEDIUM
        "soft", "软" -> Hardness.SOFT
        else -> throw AppException(ErrorCode.INVALID_ARGUMENT, "category_filter 只能是 hard、medium、soft: $raw")
    }
}
