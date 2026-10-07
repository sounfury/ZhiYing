// 分析任务的数据模型：任务、各章执行状态、用量统计与进度事件。任务运行（执行过程）与结果版本分开：
// 任务只记录"做了什么、做到哪、为什么失败"，是否产生新的可读结果看 revisionId（DESIGN §2.6、§5.2）。
package com.zhiying.application.analyze.run

import com.zhiying.domain.library.BookId
import com.zhiying.domain.library.ChapterId
import com.zhiying.domain.revision.RevisionId
import java.time.Instant

/** 分析任务的身份。 */
@JvmInline
value class TaskId(val value: String) {
    init {
        require(value.isNotBlank()) { "任务 ID 不能为空" }
    }
}

/** 任务类型：整书分析，或单章重跑。 */
enum class TaskKind { FULL, RERUN }

/** 任务状态：运行中 / 完成（已发布新结果）/ 失败（未发布）/ 已取消（未发布）。 */
enum class TaskStatus { RUNNING, COMPLETED, FAILED, CANCELLED }

/** 任务阶段，只是进度信息，不是业务状态机。 */
enum class TaskPhase { PREPARING, READING, POST_PROCESSING, INDUCING_AFFILIATIONS, PUBLISHING, FINISHED }

/** 单章在任务中的执行状态；REUSED 表示沿用了已存的有效抽取，没有重新调用模型。 */
enum class ChapterRunStatus { PENDING, RUNNING, DONE, REUSED, FAILED, CANCELLED }

/**
 * 一章在任务中的执行情况。
 *
 * 入参：[order] 阅读序号（从 1 起）；[unitsTotal]、[unitsDone] 本章阅读单元数与已读完数；
 * [error] 失败原因；[warnings] 读章的非致命警告（有警告的抽取仍可用，是否重跑由用户决定）。
 */
data class ChapterRun(
    val chapterId: ChapterId,
    val order: Int,
    val title: String,
    val status: ChapterRunStatus = ChapterRunStatus.PENDING,
    val unitsTotal: Int = 1,
    val unitsDone: Int = 0,
    val error: String? = null,
    val warnings: List<String> = emptyList(),
) {
    /** 已有可用抽取（新读完或沿用）。 */
    val succeeded: Boolean get() = status == ChapterRunStatus.DONE || status == ChapterRunStatus.REUSED
}

/** 模型用量：请求数与输入 / 输出 / 总 token，含读章、后处理与团体归纳的全部调用。 */
data class TaskUsage(
    val requests: Long = 0,
    val inputTokens: Long = 0,
    val outputTokens: Long = 0,
    val totalTokens: Long = 0,
)

/**
 * 一次分析任务的快照（不可变，运行时每次变化产生新快照）。
 *
 * 入参：[message] 终态说明（失败 / 取消的原因，或完成时的备注）；[revisionId] 本任务发布的结果版本，未发布为 null；
 * [finishedAt] 未结束为 null。
 */
data class AnalysisTask(
    val id: TaskId,
    val bookId: BookId,
    val kind: TaskKind,
    val status: TaskStatus,
    val phase: TaskPhase,
    val startedAt: Instant,
    val finishedAt: Instant? = null,
    val chapters: List<ChapterRun>,
    val usage: TaskUsage = TaskUsage(),
    val revisionId: RevisionId? = null,
    val message: String? = null,
) {
    /** 是否仍在运行。 */
    val active: Boolean get() = status == TaskStatus.RUNNING

    /** 已有可用抽取的章数。 */
    val chaptersDone: Int get() = chapters.count { it.succeeded }

    /** 失败章数。 */
    val chaptersFailed: Int get() = chapters.count { it.status == ChapterRunStatus.FAILED }

    /** 按阅读序号取一章的执行情况。 */
    fun chapter(order: Int): ChapterRun? = chapters.firstOrNull { it.order == order }

    /** 替换一章的执行情况（按章 ID 匹配），返回新快照。 */
    fun withChapter(updated: ChapterRun): AnalysisTask =
        copy(chapters = chapters.map { if (it.chapterId == updated.chapterId) updated else it })
}

/** 进度事件种类：PROGRESS 是过程中的变化，DONE 是任务终结（之后不再有事件）。 */
enum class AnalysisEventKind { PROGRESS, DONE }

/**
 * 一条进度事件：单调递增的 [id]（供断线重连去重）、种类、事件产生时的任务快照，
 * 以及触发事件的章（章级变化时有值，阶段切换时为 null）。
 */
data class AnalysisEvent(val id: Long, val kind: AnalysisEventKind, val task: AnalysisTask, val chapter: ChapterRun? = null)

/**
 * 书的分析状态，供书库列表展示：取自该书最近一次任务。
 *
 * [state] 为 UPLOADED 表示从未分析；已发布的旧结果在新任务失败后依然可读，与本状态无关。
 * [chaptersDone]、[chaptersFailed] 为最近任务中已有抽取与失败的章序号。
 */
data class BookAnalysisStatus(
    val state: State,
    val taskId: TaskId? = null,
    val totalChapters: Int = 0,
    val chaptersDone: List<Int> = emptyList(),
    val chaptersFailed: List<Int> = emptyList(),
) {
    /** 书的分析状态枚举。 */
    enum class State { UPLOADED, ANALYZING, ANALYZED, FAILED, CANCELLED }

    companion object {
        /** 从未分析过的书。 */
        val UPLOADED = BookAnalysisStatus(State.UPLOADED)

        /** 由任务快照推出书的状态：运行中 → ANALYZING，完成 → ANALYZED，失败 / 取消照实记录。 */
        fun of(task: AnalysisTask) = BookAnalysisStatus(
            state = when (task.status) {
                TaskStatus.RUNNING -> State.ANALYZING
                TaskStatus.COMPLETED -> State.ANALYZED
                TaskStatus.FAILED -> State.FAILED
                TaskStatus.CANCELLED -> State.CANCELLED
            },
            taskId = task.id,
            totalChapters = task.chapters.size,
            chaptersDone = task.chapters.filter { it.succeeded }.map { it.order },
            chaptersFailed = task.chapters.filter { it.status == ChapterRunStatus.FAILED }.map { it.order },
        )
    }
}
