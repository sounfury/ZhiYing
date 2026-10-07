// 整书分析编排：启动整书分析与单章重跑、取消、订阅进度。每次任务在独立线程里按固定顺序显式执行各副作用：
// 读章（并发池 + 滚动人名册）→ 后处理（身份 / 类型 / 补查 / 兜底）→ 团体归纳 → 保存并按"输入未变"条件发布。
// 取消与失败都不发布；上一版已发布结果始终可读（DESIGN §5.2、§5.3）。
package com.zhiying.application.analyze.run

import com.zhiying.application.analyze.AnalysisPostProcessorFactory
import com.zhiying.application.analyze.PostProcessInput
import com.zhiying.application.analyze.affiliations.AffiliationInduction
import com.zhiying.application.analyze.reading.ChapterReader
import com.zhiying.application.error.AppException
import com.zhiying.application.error.ErrorCode
import com.zhiying.application.graphquery.RevisionStore
import com.zhiying.application.library.LibraryQueries
import com.zhiying.domain.library.BookId
import com.zhiying.domain.library.Chapter
import com.zhiying.domain.library.ChapterOutline
import com.zhiying.domain.relations.AssessmentSource
import com.zhiying.domain.relations.BuiltInRelationTypes
import com.zhiying.domain.relations.Hardness
import com.zhiying.domain.revision.AnalysisRevision
import com.zhiying.domain.revision.RevisionId
import org.apache.commons.logging.LogFactory
import org.springframework.beans.factory.DisposableBean
import org.springframework.beans.factory.SmartInitializingSingleton
import org.springframework.stereotype.Service
import java.time.Instant
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * 分析任务入口。同一本书同时只能有一个任务（整书分析与单章重跑共用）。
 *
 * 失败发布规则：整书分析中只要有章读取失败，本次不发布（避免发布带缺章空洞的结果）；
 * 已读成功的章抽取照常保存，再次启动分析时沿用它们，只补读失败章。取消同样不发布。
 */
@Service
class AnalysisRunner(
    private val library: LibraryQueries,
    private val reader: ChapterReader,
    private val postProcessors: AnalysisPostProcessorFactory,
    private val affiliations: AffiliationInduction,
    private val revisions: RevisionStore,
    private val extractions: ExtractionStore,
    private val tasks: AnalysisTaskStore,
    private val settings: AnalysisSettings,
) : SmartInitializingSingleton, DisposableBean {

    private val log = LogFactory.getLog(AnalysisRunner::class.java)
    private val runs = ConcurrentHashMap<BookId, AnalysisRun>()

    /** 启动完成后，把上次进程遗留的运行中任务标记为失败（它们已经随进程中断）。 */
    override fun afterSingletonsInstantiated() {
        val n = tasks.interruptRunning("服务重启，任务被中断")
        if (n > 0) log.warn("已把 $n 个遗留的运行中分析任务标记为失败")
    }

    /** 服务关闭时请求取消全部运行中的任务，让读章尽快停止。 */
    override fun destroy() {
        runs.values.forEach { it.requestCancel() }
    }

    /**
     * 启动整书分析（异步执行，立即返回任务快照）。
     *
     * 入参：[toChapter] 只分析阅读序号不超过它的章，null 为全部参与分析的章；
     * [force] 为 false 时沿用章抽取存储里仍有效的抽取（正文修订、模型、提示词版本都未变），true 时全部重读。
     * 书不存在抛 NOT_FOUND；没有可分析章节或 [toChapter] 不合法抛 INVALID_ARGUMENT；已有任务在运行抛 ANALYSIS_ALREADY_RUNNING。
     */
    fun startFull(bookId: BookId, toChapter: Int?, force: Boolean): AnalysisTask {
        if (toChapter != null && toChapter < 1) throw AppException(ErrorCode.INVALID_ARGUMENT, "to_chapter 必须 >= 1")
        val outlines = library.listAnalyzableChapters(bookId).filter { toChapter == null || it.order <= toChapter }
        if (outlines.isEmpty()) throw AppException(ErrorCode.INVALID_ARGUMENT, "没有可分析的章节")
        return launch(bookId, TaskKind.FULL, outlines) { runFull(it, outlines, force) }
    }

    /**
     * 重跑单章（异步执行）：只重读这一章，其余章沿用已存抽取，注入当前已发布版本的人名册保持人物 ID 稳定，
     * 重新后处理并发布。章不存在抛 NOT_FOUND，章不参与分析抛 INVALID_ARGUMENT。
     */
    fun rerunChapter(bookId: BookId, order: Int): AnalysisTask {
        val outline = library.listChapters(bookId).firstOrNull { it.order == order }
            ?: throw AppException(ErrorCode.NOT_FOUND, "章节不存在：${bookId.value} 第 $order 章")
        if (!outline.inclusion.included) throw AppException(ErrorCode.INVALID_ARGUMENT, "第 $order 章不参与分析，不能重跑")
        return launch(bookId, TaskKind.RERUN, listOf(outline)) { runRerun(it, outline) }
    }

    /** 请求取消该书运行中的任务；没有运行中的任务返回 false。 */
    fun cancel(bookId: BookId): Boolean {
        val run = runs[bookId]?.takeIf { it.snapshot.active } ?: return false
        run.requestCancel()
        run.update { it } // 广播一次，让页面立刻看到"正在停止"
        return true
    }

    /** 该书运行中任务的快照；没有运行中的任务为 null。 */
    fun activeTask(bookId: BookId): AnalysisTask? = runs[bookId]?.snapshot?.takeIf { it.active }

    /**
     * 订阅该书当前（或刚结束）任务的进度事件：先回放 id 大于 [lastEventId] 的历史事件，再转入实时。
     * 没有内存中的任务（进程重启后、从未运行）返回 null，调用方改用持久化的任务快照。回调须是非阻塞的。
     */
    fun subscribe(bookId: BookId, lastEventId: Long, listener: (AnalysisEvent) -> Unit): AnalysisSubscription? =
        runs[bookId]?.subscribe(lastEventId, listener)

    /** 登记并启动任务线程：同一本书已有运行中任务则拒绝；任务行先落库，再开线程。 */
    private fun launch(bookId: BookId, kind: TaskKind, outlines: List<ChapterOutline>, body: (AnalysisRun) -> Unit): AnalysisTask {
        val run = synchronized(runs) {
            if (runs[bookId]?.snapshot?.active == true) throw AppException(ErrorCode.ANALYSIS_ALREADY_RUNNING)
            val task = AnalysisTask(
                id = TaskId(UUID.randomUUID().toString()),
                bookId = bookId,
                kind = kind,
                status = TaskStatus.RUNNING,
                phase = TaskPhase.PREPARING,
                startedAt = Instant.now(),
                chapters = outlines.map { ChapterRun(it.id, it.order, it.title) },
            )
            tasks.create(task)
            AnalysisRun(task, tasks, settings.maxRequests, settings.maxTokens).also { runs[bookId] = it }
        }
        Thread.ofPlatform().name("analysis-${bookId.value}").start { execute(run, body) }
        return run.snapshot
    }

    /** 任务线程主体：任何未预期异常都收口成失败终态，保证任务一定会结束。 */
    private fun execute(run: AnalysisRun, body: (AnalysisRun) -> Unit) {
        try {
            body(run)
        } catch (e: Exception) {
            log.error("分析任务异常终止：${run.id.value}", e)
            run.finish(TaskStatus.FAILED, "内部错误：${e.message ?: e.javaClass.simpleName}")
        }
        if (run.snapshot.active) run.finish(TaskStatus.FAILED, "任务结束时状态未收口")
    }

    // ───────────────────────── 整书分析 ─────────────────────────

    /** 整书分析：读取章节 → 阅读阶段 → 校验是否可发布 → 后处理、归纳与发布。 */
    private fun runFull(run: AnalysisRun, outlines: List<ChapterOutline>, force: Boolean) {
        val bookId = run.snapshot.bookId
        val expected = revisions.publishedId(bookId)
        val chapters = outlines.map { library.readChapter(it.id) }
        val items = chapters.map { ReadItem(it, if (force) null else reusable(it)) }
        run.setPhase(TaskPhase.READING)
        val extracted = ReadingPhase(reader, settings, run, extractions, bookId)
            .execute(items, emptyList(), BuiltInRelationTypes.library())
        if (!readingSucceeded(run)) return
        val ordered = chapters.map { extracted.getValue(it.id) }
        val input = PostProcessInput(
            bookId = bookId,
            revisionId = RevisionId(UUID.randomUUID().toString()),
            extractions = ordered,
            chapterOrder = outlines.associate { it.id to it.order },
        )
        publish(run, input, expected)
    }

    /** 已存抽取在正文修订、模型、提示词版本都未变时可沿用。 */
    private fun reusable(chapter: Chapter): StoredExtraction? =
        extractions.findCurrent(chapter.id)?.takeIf { it.extraction.provenance == reader.provenanceFor(chapter.revision) }

    // ───────────────────────── 单章重跑 ─────────────────────────

    /** 单章重跑：重读本章 → 用其余章的当前抽取与已发布版本的人名册 / 类型库 / 历史软关系重建 → 发布。 */
    private fun runRerun(run: AnalysisRun, outline: ChapterOutline) {
        val bookId = run.snapshot.bookId
        val expected = revisions.publishedId(bookId)
        val published = revisions.findPublished(bookId)
        val chapter = library.readChapter(outline.id)
        run.setPhase(TaskPhase.READING)
        val extracted = ReadingPhase(reader, settings, run, extractions, bookId)
            .execute(listOf(ReadItem(chapter)), published?.persons.orEmpty(), published?.types ?: BuiltInRelationTypes.library())
        if (!readingSucceeded(run)) return
        val orderOf = library.listChapters(bookId).associate { it.id to it.order }
        // 其余章取当前抽取；已有发布版本时保持它的覆盖范围，本章无论是否在范围内都计入
        val others = extractions.listCurrent(bookId).map { it.extraction }
            .filter { it.chapterId != chapter.id && (published == null || it.chapterId in published.analyzedChapters) }
        val ordered = (others + extracted.getValue(chapter.id)).sortedBy { orderOf[it.chapterId] ?: Int.MAX_VALUE }
        val input = PostProcessInput(
            bookId = bookId,
            revisionId = RevisionId(UUID.randomUUID().toString()),
            extractions = ordered,
            roster = published?.persons.orEmpty(),
            retained = retainedSoftRelations(published, chapter),
            types = published?.types ?: BuiltInRelationTypes.library(),
            chapterOrder = orderOf.filterKeys { id -> ordered.any { it.chapterId == id } },
            rerunChapter = chapter.id,
        )
        publish(run, input, expected)
    }

    /** 上一版中由软兜底产生、且来源章不是被重跑章的记录：来源仍然有效，交给后处理保留。 */
    private fun retainedSoftRelations(published: AnalysisRevision?, rerun: Chapter) =
        published?.occurrences
            ?.filter {
                (it.assessment.source == AssessmentSource.SOFT_FALLBACK || it.assessment.source == AssessmentSource.RULE) &&
                    it.chapterId != rerun.id &&
                    published.types[it.key.type]?.hardness == Hardness.SOFT
            }
            .orEmpty()

    // ───────────────────────── 共用收尾 ─────────────────────────

    /** 阅读阶段后的发布前检查：取消或有章失败都不发布，写入终态并返回 false。 */
    private fun readingSucceeded(run: AnalysisRun): Boolean {
        if (run.cancelRequested) {
            run.finish(TaskStatus.CANCELLED, CANCEL_MESSAGE)
            return false
        }
        val failed = run.snapshot.chapters.filter { it.status == ChapterRunStatus.FAILED }
        if (failed.isEmpty()) return true
        val orders = failed.take(MAX_LISTED).joinToString("、") { "第${it.order}章" } + if (failed.size > MAX_LISTED) " 等" else ""
        val advice = if (run.snapshot.kind == TaskKind.RERUN) {
            "重跑失败，上一版结果保持不变"
        } else {
            "本次未发布，上一版结果保持不变；已读成功的章抽取已保存，重新启动分析会沿用它们，只补读失败章"
        }
        run.finish(TaskStatus.FAILED, "${failed.size} 章读取失败（$orders），$advice")
        return false
    }

    /** 后处理 → 团体归纳 → 保存 → 条件发布；每个阶段后检查取消。 */
    private fun publish(run: AnalysisRun, input: PostProcessInput, expected: RevisionId?) {
        run.setPhase(TaskPhase.POST_PROCESSING)
        val processed = postProcessors.create(run.control).process(input)
        if (cancelled(run)) return
        run.setPhase(TaskPhase.INDUCING_AFFILIATIONS)
        val revision = affiliations.run(processed.revision, input.extractions, run.control)
        if (cancelled(run)) return
        run.setPhase(TaskPhase.PUBLISHING)
        revisions.save(revision)
        if (!revisions.publishIfCurrent(revision.bookId, revision.id, expected)) {
            run.finish(TaskStatus.FAILED, "发布前已有其他结果版本被发布，本次结果未发布")
            return
        }
        run.finish(TaskStatus.COMPLETED, "已发布：人物 ${revision.persons.size}，关系记录 ${revision.occurrences.size}", revision.id)
    }

    /** 已请求取消则写入取消终态并返回 true。 */
    private fun cancelled(run: AnalysisRun): Boolean {
        if (!run.cancelRequested) return false
        run.finish(TaskStatus.CANCELLED, CANCEL_MESSAGE)
        return true
    }

    private companion object {
        const val CANCEL_MESSAGE = "已取消，本次未发布，上一版结果保持不变"
        const val MAX_LISTED = 10
    }
}
