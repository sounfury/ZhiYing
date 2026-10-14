// 反馈 HTTP 入口：用户提交对象或通用反馈，管理员按书查看并导出 JSONL 快照。
package com.zhiying.web.feedback

import com.zhiying.application.feedback.FeedbackInput
import com.zhiying.application.feedback.Feedbacks
import com.zhiying.domain.account.Account
import com.zhiying.domain.library.BookId
import org.springframework.http.HttpHeaders
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestAttribute
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.ResponseStatus
import org.springframework.web.bind.annotation.RestController
import tools.jackson.databind.ObjectMapper
import tools.jackson.databind.SerializationFeature

@RestController
class FeedbackController(
    private val feedbacks: Feedbacks,
    private val mapper: ObjectMapper,
) {
    @PostMapping("/api/feedback")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun general(
        @RequestAttribute("user") user: Account,
        @RequestBody input: FeedbackInput,
    ) = feedbacks.submit(user, null, input)

    @PostMapping("/api/books/{bookId}/feedback")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun objectFeedback(
        @RequestAttribute("user") user: Account,
        @PathVariable bookId: String,
        @RequestBody input: FeedbackInput,
    ) = feedbacks.submit(user, BookId(bookId), input)

    @GetMapping("/api/admin/feedback")
    fun list(
        @RequestAttribute("user") user: Account,
        @RequestParam(required = false) book: String?,
    ) = feedbacks.list(user, book)

    @GetMapping("/api/admin/feedback/export", produces = ["application/x-ndjson"])
    fun export(
        @RequestAttribute("user") user: Account,
        @RequestParam(required = false) book: String?,
    ): ResponseEntity<String> {
        val rows = feedbacks.list(user, book)
        val writer = mapper.writer().without(SerializationFeature.INDENT_OUTPUT)
        val body = rows.joinToString("\n", postfix = if (rows.isEmpty()) "" else "\n") { writer.writeValueAsString(it) }
        return ResponseEntity
            .ok()
            .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=feedback.jsonl")
            .body(body)
    }
}
