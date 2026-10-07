// 单个 SSE 连接的发送器：事件先入本连接自己的单线程队列再写出，慢客户端不会拖住分析任务；
// 任务终结事件发出后关闭连接，连接断开 / 超时 / 出错时自动取消订阅，页面断开不影响任务运行。
package com.zhiying.web.analysis

import com.zhiying.application.analyze.run.AnalysisEvent
import com.zhiying.application.analyze.run.AnalysisEventKind
import com.zhiying.application.analyze.run.AnalysisSubscription
import com.zhiying.application.analyze.run.AnalysisTask
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter
import tools.jackson.databind.json.JsonMapper
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/**
 * 入参：[emitter] 本连接的 SseEmitter；[json] 序列化事件数据；[keepalive] 共享的定时器，用来定期发注释行防止代理断开空闲连接。
 */
internal class SseSender(
    val emitter: SseEmitter,
    private val json: JsonMapper,
    keepalive: ScheduledExecutorService,
) {
    private val queue: ExecutorService = Executors.newSingleThreadExecutor(Thread.ofVirtual().name("sse-sender-", 0).factory())
    private val ticker: ScheduledFuture<*> =
        keepalive.scheduleWithFixedDelay({ enqueue { emitter.send(SseEmitter.event().comment("keepalive")) } }, KEEPALIVE_SECONDS, KEEPALIVE_SECONDS, TimeUnit.SECONDS)

    @Volatile
    private var subscription: AnalysisSubscription? = null

    init {
        emitter.onCompletion(::close)
        emitter.onTimeout(::close)
        emitter.onError { close() }
    }

    /** 登记订阅句柄，连接关闭时一并取消。 */
    fun attach(subscription: AnalysisSubscription) {
        this.subscription = subscription
        if (queue.isShutdown) subscription.close() // 回放时已经收到终结事件
    }

    /** 作为订阅回调：把一条任务事件排入队列（非阻塞）。队列已关闭时抛异常，订阅方据此移除本订阅。 */
    fun onEvent(event: AnalysisEvent) {
        val kind = if (event.kind == AnalysisEventKind.DONE) "done" else "progress"
        val data = if (event.kind == AnalysisEventKind.DONE) AnalysisPayloads.done(event.task) else AnalysisPayloads.progress(event)
        enqueue {
            emitter.send(SseEmitter.event().id(event.id.toString()).name(kind).data(json.writeValueAsString(data)))
            if (event.kind == AnalysisEventKind.DONE) finish()
        }
    }

    /** 没有内存中的任务时，用持久化的最近一次任务（或 idle）合成一条 done 事件并结束连接。 */
    fun sendFinal(task: AnalysisTask?) {
        enqueue {
            emitter.send(SseEmitter.event().name("done").data(json.writeValueAsString(AnalysisPayloads.done(task))))
            finish()
        }
    }

    /** 在发送线程里执行一次写出；写失败说明客户端已断开，直接关闭。 */
    private fun enqueue(action: () -> Unit) {
        queue.execute {
            try {
                action()
            } catch (e: Exception) {
                close()
            }
        }
    }

    /** 正常结束：完成响应并释放资源。 */
    private fun finish() {
        emitter.complete()
        close()
    }

    /** 取消订阅、停止心跳、关闭发送线程；可重复调用。 */
    private fun close() {
        subscription?.close()
        ticker.cancel(false)
        queue.shutdown()
    }

    private companion object {
        const val KEEPALIVE_SECONDS = 30L
    }
}
