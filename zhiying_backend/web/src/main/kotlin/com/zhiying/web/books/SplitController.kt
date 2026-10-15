// TXT 分章方案接口：GET /split-preview 试切全部方案，POST /split 改选方案（清空分析并重新切章）。
package com.zhiying.web.books

import com.fasterxml.jackson.annotation.JsonProperty
import com.zhiying.application.importbook.ResplitBook
import com.zhiying.application.importbook.SplitPreview
import com.zhiying.domain.library.BookId
import org.springframework.http.HttpStatus
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.ResponseStatus
import org.springframework.web.bind.annotation.RestController

/** 分章方案 HTTP 接口；权限由拦截器按读 / 写路由判定。 */
@RestController
@RequestMapping("/api/books/{bookId}")
class SplitController(
    private val resplit: ResplitBook,
) {
    /** 每种方案的章数与开头、中间、结尾各 3 章标题，current 标出当前方案；不是 TXT 返回 INVALID_ARGUMENT。 */
    @GetMapping("/split-preview")
    fun preview(
        @PathVariable bookId: String,
    ) = SplitPreviewListResponse(resplit.preview(BookId(bookId)).map(SplitPreviewResponse::from))

    /** 改选方案，返回 204；会清空现有分析，正在分析返回 ANALYSIS_ALREADY_RUNNING。 */
    @PostMapping("/split")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun split(
        @PathVariable bookId: String,
        @RequestBody body: SplitRequest,
    ) = resplit.resplit(BookId(bookId), body.rule)
}

/** 改选请求：[rule] 为方案 id。 */
data class SplitRequest(
    val rule: String,
)

/** 一种方案的试切结果。 */
data class SplitPreviewResponse(
    val id: String,
    val name: String,
    val example: String,
    @JsonProperty("chapter_count") val chapterCount: Int,
    val beginning: List<String>,
    val middle: List<String>,
    val end: List<String>,
    val current: Boolean,
) {
    companion object {
        fun from(p: SplitPreview) = SplitPreviewResponse(p.id, p.name, p.example, p.chapterCount, p.beginning, p.middle, p.end, p.current)
    }
}

/** 方案预览列表。 */
data class SplitPreviewListResponse(
    val rules: List<SplitPreviewResponse>,
)
