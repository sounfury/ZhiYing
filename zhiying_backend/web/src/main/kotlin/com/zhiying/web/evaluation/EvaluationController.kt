// 评测接口（DESIGN §7）：列评测集、准备并发起整书分析、给当前结果评分、查运行记录。
// 报告结构较深，统一用 snake_case 映射器整体序列化，不为每层另写响应类。
package com.zhiying.web.evaluation

import com.zhiying.application.evaluation.Evaluations
import org.springframework.http.HttpStatus
import org.springframework.http.MediaType
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController
import tools.jackson.databind.PropertyNamingStrategies
import tools.jackson.databind.json.JsonMapper
import tools.jackson.module.kotlin.jacksonMapperBuilder

@RestController
@RequestMapping("/api/eval/suites")
class EvaluationController(private val evaluations: Evaluations) {

    private val json: JsonMapper = jacksonMapperBuilder()
        .propertyNamingStrategy(PropertyNamingStrategies.SNAKE_CASE)
        .build()

    /** 评测集列表，附书库里对应的书与最近一次运行摘要。 */
    @GetMapping
    fun suites(): ResponseEntity<String> = ok(mapOf("suites" to evaluations.listSuites()))

    /**
     * 准备并发起整书分析（异步，返回 202）：未导入则导入，已导入则清空分析后全部重读。
     * 进度走 `/api/books/{book_id}/progress`；完成后调用评分接口。该书正在分析返回 409。
     */
    @PostMapping("/{name}/prepare")
    fun prepare(@PathVariable name: String): ResponseEntity<String> {
        val prepared = evaluations.prepare(name)
        val body = mapOf(
            "book_id" to prepared.bookId.value,
            "task_id" to prepared.task.id.value,
            "total_chapters" to prepared.task.chapters.size,
            "imported" to prepared.imported,
        )
        return ResponseEntity.status(HttpStatus.ACCEPTED).contentType(JSON_UTF8).body(json.writeValueAsString(body))
    }

    /** 给该书当前已发布的结果评分，保存并返回完整运行记录。 */
    @PostMapping("/{name}/runs")
    fun score(@PathVariable name: String): ResponseEntity<String> = ok(evaluations.score(name))

    /** 运行摘要列表，新的在前。 */
    @GetMapping("/{name}/runs")
    fun runs(@PathVariable name: String): ResponseEntity<String> = ok(mapOf("runs" to evaluations.listRuns(name)))

    /** 一次运行的完整记录。 */
    @GetMapping("/{name}/runs/{runId}")
    fun run(@PathVariable name: String, @PathVariable runId: String): ResponseEntity<String> = ok(evaluations.getRun(name, runId))

    private fun ok(body: Any): ResponseEntity<String> =
        ResponseEntity.ok().contentType(JSON_UTF8).body(json.writeValueAsString(body))

    private companion object {
        /** 显式带字符集，避免字符串响应按默认字符集输出中文。 */
        val JSON_UTF8 = MediaType("application", "json", Charsets.UTF_8)
    }
}
