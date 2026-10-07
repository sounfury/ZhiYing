// 分析编排的存储端口：任务快照与书的分析状态、章抽取记录；由基础设施用 SQLite 实现，应用层只依赖这里的约定。
package com.zhiying.application.analyze.run

import com.zhiying.domain.extraction.ChapterExtraction
import com.zhiying.domain.extraction.ExtractionId
import com.zhiying.domain.library.BookId
import com.zhiying.domain.library.ChapterId
import java.time.Instant

/** 任务存储：任务快照整体覆盖写入，查询用于刷新页面、断线重连与重启后的诊断。 */
interface AnalysisTaskStore {
    /** 创建任务：写入任务行与全部章执行行。整书任务同时登记该书的分析状态。 */
    fun create(task: AnalysisTask)

    /**
     * 更新任务：覆盖任务行，并覆盖 [changed] 这一章的执行行（阶段级变化时为 null，只写任务行）。
     * 整书任务同时刷新书的分析状态；单章重跑不改写书的分析状态。
     * 写入是短事务，调用方不得在模型调用期间持有事务；章数很多时不能每次都重写全部章。
     */
    fun update(task: AnalysisTask, changed: ChapterRun? = null)

    /** 按任务 ID 取快照。 */
    fun find(id: TaskId): AnalysisTask?

    /** 取某本书最近一次（按开始时间）任务，无则为 null。 */
    fun latest(bookId: BookId): AnalysisTask?

    /** 取书的分析状态（最近一次整书任务）；从未分析过返回 [BookAnalysisStatus.UPLOADED]。 */
    fun bookStatus(bookId: BookId): BookAnalysisStatus

    /** 按书汇总全部任务（整书与单章重跑，含失败、取消）的累计用量，一次聚合；从未分析返回全 0。 */
    fun usageByBook(bookIds: Collection<BookId>): Map<BookId, TaskUsage>

    /** 服务启动时把遗留的运行中任务标记为失败（进程重启已中断它们），返回处理的任务数。 */
    fun interruptRunning(reason: String): Int
}

/** 已存的章抽取：抽取本身，加上读章时的警告与产生它的任务。 */
data class StoredExtraction(
    val extraction: ChapterExtraction,
    val taskId: TaskId,
    val warnings: List<String>,
    val createdAt: Instant,
)

/**
 * 章抽取存储。抽取记录一经写入不再修改；重跑产生新记录，该章的"当前抽取"指针指向最新一条。
 */
interface ExtractionStore {
    /** 保存一份章抽取并把该章当前指针切到它（同一短事务）；[bookId] 用于按书列出。 */
    fun save(bookId: BookId, taskId: TaskId, extraction: ChapterExtraction, warnings: List<String>)

    /** 取某章当前的抽取；该章尚无抽取返回 null。 */
    fun findCurrent(chapterId: ChapterId): StoredExtraction?

    /** 列出某本书各章当前的抽取（顺序不保证，调用方按阅读序号排列）。 */
    fun listCurrent(bookId: BookId): List<StoredExtraction>

    /** 按抽取 ID 取历史记录（含已被后来重跑取代的）。 */
    fun find(id: ExtractionId): StoredExtraction?
}
