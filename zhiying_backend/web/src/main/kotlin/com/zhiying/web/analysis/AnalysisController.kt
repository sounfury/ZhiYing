// 分析接口：启动整书分析、任务快照、SSE 进度流、取消、单章重跑、查询某章抽取结果。路径与字段沿用旧后端，
// 章参数 {cid} 与响应里的 chapter_id 都是从 1 开始的阅读序号。错误统一走 ErrorCode。
package com.zhiying.web.analysis

import com.fasterxml.jackson.annotation.JsonProperty
import com.zhiying.application.analyze.run.AnalysisQueries
import com.zhiying.application.analyze.run.AnalysisRunner
import com.zhiying.application.analyze.run.AnalysisTask
import com.zhiying.application.library.LibraryQueries
import com.zhiying.domain.library.BookId
import org.springframework.http.MediaType
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestHeader
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter
import tools.jackson.databind.json.JsonMapper
import java.util.concurrent.Executors

/** 分析相关 HTTP 接口。 */
@RestController
@RequestMapping("/api/books/{bookId}")
class AnalysisController(
    private val runner: AnalysisRunner,
    private val queries: AnalysisQueries,
    private val library: LibraryQueries,
    private val json: JsonMapper,
) {
    /** 所有 SSE 连接共用的心跳定时器。 */
    private val keepalive = Executors.newSingleThreadScheduledExecutor(Thread.ofPlatform().name("sse-keepalive").daemon(true).factory())

    /**
     * 启动整书分析（异步，返回 202 与任务 ID）。
     *
     * 参数：to_chapter 只分析阅读序号不超过它的章；force 为 true 时忽略已存抽取、全部重读（默认沿用有效抽取，
     * 所以对失败的整书分析再次启动即"只补读失败章"）。已有任务在运行返回 409 ANALYSIS_ALREADY_RUNNING。
     */
    @PostMapping("/analyze")
    fun start(
        @PathVariable bookId: String,
        @RequestParam("to_chapter", required = false) toChapter: Int?,
        @RequestParam("force", defaultValue = "false") force: Boolean,
    ): ResponseEntity<StartResponse> =
        ResponseEntity.accepted().body(StartResponse.from("started", runner.startFull(BookId(bookId), toChapter, force)))

    /** 任务快照：运行中返回实时快照，否则返回最近一次任务；从未分析过返回 idle。用于页面刷新与断线恢复。 */
    @GetMapping("/analysis/task")
    fun task(@PathVariable bookId: String): Map<String, Any?> = AnalysisPayloads.snapshot(queries.currentTask(BookId(bookId)))

    /**
     * SSE 进度流。事件 progress（逐章 / 阶段变化）与 done（任务终结，之后连接关闭）；每条事件带单调递增的 id，
     * 断线重连时浏览器自动带 Last-Event-ID，服务端只回放更新的事件。没有内存中的任务（重启后 / 已久远）时，
     * 用持久化的最近一次任务合成一条 done。页面断开不影响任务运行。
     */
    @GetMapping("/progress", produces = [MediaType.TEXT_EVENT_STREAM_VALUE])
    fun progress(
        @PathVariable bookId: String,
        @RequestHeader("Last-Event-ID", required = false) lastEventId: String?,
    ): SseEmitter {
        val id = BookId(bookId)
        library.getBook(id) // 书不存在返回 404，而不是一个空的事件流
        val sender = SseSender(SseEmitter(0L), json, keepalive)
        val emitter = sender.emitter
        val subscription = runner.subscribe(id, lastEventId?.toLongOrNull() ?: 0L, sender::onEvent)
        if (subscription != null) sender.attach(subscription) else sender.sendFinal(queries.currentTask(id))
        return emitter
    }

    /** 请求取消运行中的任务：不再启动新的阅读单元，进行中的模型调用在下次请求前停止，不发布结果。 */
    @PostMapping("/analyze/stop")
    fun stop(@PathVariable bookId: String): Map<String, String> =
        if (runner.cancel(BookId(bookId))) {
            mapOf("status" to "stopping")
        } else {
            mapOf("status" to "idle", "message" to "No analysis running")
        }

    /**
     * 重跑单章（异步，返回 202 与任务 ID，进度走同一条 SSE）：只重读该章，其余章沿用已存抽取，
     * 注入已发布版本的人名册保持人物 ID 稳定，重新后处理并发布；失败时上一版结果保持不变。
     */
    @PostMapping("/chapters/{cid}/rerun")
    fun rerun(@PathVariable bookId: String, @PathVariable cid: Int): ResponseEntity<StartResponse> =
        ResponseEntity.accepted().body(StartResponse.from("started", runner.rerunChapter(BookId(bookId), cid)))

    /** 某章当前的抽取结果（人物、关系候选及首次判断、交流观察、摘要、读章警告）；该章尚未分析返回 404。 */
    @GetMapping("/chapters/{cid}/result")
    fun result(@PathVariable bookId: String, @PathVariable cid: Int): Map<String, Any?> {
        val id = BookId(bookId)
        val stored = queries.chapterExtraction(id, cid)
        return AnalysisPayloads.extraction(cid, stored, library.readChapter(id, cid))
    }
}

/** 启动 / 重跑的响应：任务 ID 与本任务涉及的章数。 */
data class StartResponse(
    val status: String,
    @JsonProperty("total_chapters") val totalChapters: Int,
    @JsonProperty("task_id") val taskId: String,
) {
    companion object {
        /** 由刚创建的任务快照构造。 */
        fun from(status: String, task: AnalysisTask) = StartResponse(status, task.chapters.size, task.id.value)
    }
}
