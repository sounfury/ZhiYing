// 一次运行中任务的内存状态：当前快照、进度事件历史与订阅者、取消标志、任务级预算。
// 所有状态变化都经 update 产生新快照，同时落库并广播事件；订阅者回调须是非阻塞的（Web 层自行排队）。
package com.zhiying.application.analyze.run

import com.zhiying.application.llm.CancelSignal
import com.zhiying.application.llm.ModelCallBudget
import com.zhiying.application.llm.ModelCallControl
import com.zhiying.domain.library.ChapterId
import com.zhiying.domain.revision.RevisionId
import java.time.Instant
import java.util.concurrent.CopyOnWriteArrayList

/** 订阅句柄：关闭后不再收到事件。 */
fun interface AnalysisSubscription : AutoCloseable {
    /** 取消订阅。 */
    override fun close()
}

/**
 * 运行中的任务。
 *
 * 入参：[initial] 初始快照；[tasks] 快照存储；[maxRequests]、[maxTokens] 整个任务的模型预算（0 不限）。
 * 取消只是置位 [cancelRequested]，由 [control] 的取消信号传给每一次模型调用；取消信号不被通用异常吞掉。
 */
class AnalysisRun(initial: AnalysisTask, private val tasks: AnalysisTaskStore, maxRequests: Long, maxTokens: Long) {
    private val lock = Any()
    private var task = initial
    private var sequence = 0L
    private val history = ArrayDeque<AnalysisEvent>()
    private val listeners = CopyOnWriteArrayList<(AnalysisEvent) -> Unit>()

    @Volatile
    var cancelRequested: Boolean = false
        private set

    /** 任务级预算与取消信号，传给读章、后处理与团体归纳的全部调用，任务用量即取自该预算。 */
    val control = ModelCallControl(ModelCallBudget(maxRequests, maxTokens), CancelSignal { cancelRequested })

    /** 当前快照。 */
    val snapshot: AnalysisTask get() = synchronized(lock) { task }

    /** 任务 ID。 */
    val id: TaskId = initial.id

    /** 请求取消：之后不再启动新的阅读单元，进行中的模型调用在下次请求前停止。 */
    fun requestCancel() {
        cancelRequested = true
    }

    /** 切换阶段并广播。 */
    fun setPhase(phase: TaskPhase) = update { it.copy(phase = phase) }

    /** 修改一章的执行情况并广播（章级事件）；章不在任务内则忽略。 */
    fun updateChapter(chapterId: ChapterId, change: (ChapterRun) -> ChapterRun) {
        synchronized(lock) {
            val current = task.chapters.firstOrNull { it.chapterId == chapterId } ?: return
            val updated = change(current)
            emit(AnalysisEventKind.PROGRESS, task.withChapter(updated), updated)
        }
    }

    /** 以 [change] 产生新快照并广播（阶段级事件）。 */
    fun update(change: (AnalysisTask) -> AnalysisTask) {
        synchronized(lock) { emit(AnalysisEventKind.PROGRESS, change(task), null) }
    }

    /** 终结任务：写入终态、结束时间与说明，广播 DONE 事件并只保留这一条历史，之后不再有事件。 */
    fun finish(status: TaskStatus, message: String?, revisionId: RevisionId? = null) {
        synchronized(lock) {
            val done = task.copy(
                status = status,
                phase = TaskPhase.FINISHED,
                finishedAt = Instant.now(),
                message = message,
                revisionId = revisionId,
            )
            emit(AnalysisEventKind.DONE, done, null)
            history.removeAll { it.kind != AnalysisEventKind.DONE }
        }
    }

    /**
     * 订阅事件：先把历史中 id 大于 [lastEventId] 的事件依次回放，再转入实时；回放与登记是原子的，不会漏也不会乱序。
     * 任务已终结时回放的最后一条是 DONE，之后不会有新事件。
     */
    fun subscribe(lastEventId: Long, listener: (AnalysisEvent) -> Unit): AnalysisSubscription {
        synchronized(lock) {
            history.filter { it.id > lastEventId }.forEach { deliver(listener, it) }
            listeners += listener
        }
        return AnalysisSubscription { listeners -= listener }
    }

    /** 应用变化：刷新用量、落库、记入历史并通知订阅者；调用方须持有 [lock]。 */
    private fun emit(kind: AnalysisEventKind, next: AnalysisTask, chapter: ChapterRun?) {
        val budget = control.budget
        task = next.copy(
            usage = TaskUsage(budget.usedRequests, budget.usedInputTokens, budget.usedOutputTokens, budget.usedTokens),
        )
        tasks.update(task, chapter)
        val event = AnalysisEvent(++sequence, kind, task, chapter)
        history.addLast(event)
        if (history.size > HISTORY_LIMIT) history.removeFirst()
        listeners.forEach { deliver(it, event) }
    }

    /** 通知一个订阅者；回调抛异常（如连接已断开）就移除它，不影响任务与其他订阅者。 */
    private fun deliver(listener: (AnalysisEvent) -> Unit, event: AnalysisEvent) {
        try {
            listener(event)
        } catch (e: Exception) {
            listeners -= listener
        }
    }

    private companion object {
        /** 内存中保留的事件条数，只够断线重连回放。 */
        const val HISTORY_LIMIT = 500
    }
}
