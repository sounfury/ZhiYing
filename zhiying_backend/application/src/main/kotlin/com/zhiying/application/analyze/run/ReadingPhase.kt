// 阅读阶段：把全部阅读单元按阅读顺序送进并发池，滚动更新人名册，并把每章各单元的抽取合并保存。
// 调度规则见 DESIGN §3.1：无波次屏障；第一个单元单独先读（暖启动）；每个单元完成后串行做一次确定性身份对齐，
// 之后启动的单元拿最新人名册快照；同一章的各段严格串行（段 k+1 等段 k 完成并对齐后才启动，等待中的段不占并发名额），跨章并行。
// 所有任务状态变化都发生在调用 execute 的这一个线程上，只有读章本身在池线程里。
package com.zhiying.application.analyze.run

import com.zhiying.application.analyze.reading.ChapterReadRequest
import com.zhiying.application.analyze.reading.ChapterReadResult
import com.zhiying.application.analyze.reading.ChapterReader
import com.zhiying.application.diagnostics.ModelFailure
import com.zhiying.application.llm.ModelCallStats
import com.zhiying.domain.extraction.ChapterExtraction
import com.zhiying.domain.extraction.ExtractionId
import com.zhiying.domain.extraction.ReadingUnit
import com.zhiying.domain.extraction.ReadingUnits
import com.zhiying.domain.identity.IdentityAlignment
import com.zhiying.domain.identity.Person
import com.zhiying.domain.library.BookId
import com.zhiying.domain.library.Chapter
import com.zhiying.domain.library.ChapterId
import com.zhiying.domain.relations.RelationTypeLibrary
import java.util.UUID
import java.util.concurrent.ExecutorCompletionService
import java.util.concurrent.Executors

/** 阅读阶段的一项输入：要读的章；[reused] 非空表示沿用已存的有效抽取，不调用模型。 */
class ReadItem(val chapter: Chapter, val reused: StoredExtraction? = null)

/**
 * 阅读阶段执行器，一次任务一个实例。
 *
 * 入参：[reader] 章阅读端口；[settings] 并发与切段上限；[run] 任务运行状态（进度、取消、预算）；
 * [extractions] 章抽取存储；[bookId] 所属书。
 */
class ReadingPhase(
    private val reader: ChapterReader,
    private val settings: AnalysisSettings,
    private val run: AnalysisRun,
    private val extractions: ExtractionStore,
    private val bookId: BookId,
) {
    /** 一章在本阶段的收集状态：已读完的各单元抽取、失败说明与警告。 */
    private class Slot(val item: ReadItem, val units: List<ReadingUnit>) {
        val parts = sortedMapOf<Int, ChapterExtraction>()
        val failures = mutableListOf<String>()
        val warnings = mutableListOf<String>()
        var done = 0
        var started = false
        var running = false
        var settled = false
    }

    /** 调度步骤：读一个单元，或沿用已存抽取。 */
    private sealed interface Step {
        class Read(val slot: Slot, val unit: ReadingUnit) : Step
        class Reuse(val slot: Slot) : Step
    }

    private class UnitResult(val step: Step.Read, val result: ChapterReadResult)

    private val settled = LinkedHashMap<ChapterId, ChapterExtraction>()
    private val pool = Executors.newFixedThreadPool(settings.concurrency)
    private val completion = ExecutorCompletionService<UnitResult>(pool)
    private var roster: List<Person> = emptyList()
    private var fatal: String? = null
    private var inFlight = 0
    private var warm = false

    /**
     * 执行阅读阶段。
     *
     * 入参：[items] 按阅读顺序排列的章；[baseRoster] 起始人名册（单章重跑为已发布版本的人物）；[library] 可引用的类型库。
     * 出参：每个成功章（含沿用）的章抽取；失败、取消的章不在其中，状态已写入任务。
     */
    fun execute(items: List<ReadItem>, baseRoster: List<Person>, library: RelationTypeLibrary): Map<ChapterId, ChapterExtraction> {
        roster = baseRoster
        val slots = items.map { Slot(it, plan(it)) }
        val pending = slots.flatMapTo(mutableListOf(), ::stepsOf)
        announcePlan(slots)
        try {
            drive(pending, library)
        } finally {
            pool.shutdownNow()
        }
        slots.filterNot { it.settled }.forEach { abandon(it) }
        return settled
    }

    /** 切阅读单元；沿用已存抽取的章不需要。 */
    private fun plan(item: ReadItem): List<ReadingUnit> =
        if (item.reused != null) emptyList() else ReadingUnits.plan(item.chapter.id, item.chapter.text, settings.unitMaxChars)

    private fun stepsOf(slot: Slot): List<Step> =
        if (slot.item.reused != null) listOf(Step.Reuse(slot)) else slot.units.map { Step.Read(slot, it) }

    /** 把每章的单元数一次性写入任务（一个事件），页面据此显示"第几段 / 共几段"。 */
    private fun announcePlan(slots: List<Slot>) {
        val totals = slots.filter { it.units.isNotEmpty() }.associate { it.item.chapter.id to it.units.size }
        run.update { task -> task.copy(chapters = task.chapters.map { c -> totals[c.chapterId]?.let { c.copy(unitsTotal = it) } ?: c }) }
    }

    /** 主循环：补满并发位 → 等一个单元完成并吸收 → 再补满，直到没有在途单元。 */
    private fun drive(pending: MutableList<Step>, library: RelationTypeLibrary) {
        launchAvailable(pending, library)
        while (inFlight > 0) {
            val finished = completion.take().get()
            inFlight--
            warm = true
            absorb(finished)
            launchAvailable(pending, library)
        }
    }

    /**
     * 按阅读顺序扫描待办步骤，启动第一批可启动的单元：沿用步骤直接处理；同章已有单元在读的后续段跳过（不占并发位）；
     * 已失败章的剩余段丢弃；并发位用尽即返回。暖启动期间只允许一个在途单元。
     */
    private fun launchAvailable(pending: MutableList<Step>, library: RelationTypeLibrary) {
        val steps = pending.iterator()
        while (steps.hasNext() && !stopped()) {
            when (val step = steps.next()) {
                is Step.Reuse -> reuse(step.slot).also { steps.remove() }
                is Step.Read -> when {
                    step.slot.failures.isNotEmpty() -> steps.remove()
                    step.slot.running -> Unit
                    inFlight >= (if (warm) settings.concurrency else 1) -> return
                    else -> launch(step, library).also { steps.remove() }
                }
            }
        }
    }

    /** 提交一个单元到池：章标记运行中，并带上此刻最新的人名册快照（同章前一段的人物已在其中）。 */
    private fun launch(step: Step.Read, library: RelationTypeLibrary) {
        begin(step.slot)
        step.slot.running = true
        val rosterSnapshot = roster
        completion.submit { UnitResult(step, readUnit(step, rosterSnapshot, library)) }
        inFlight++
    }

    /** 用户取消或遇到必然全部失败的错误（鉴权、余额、预算）后不再启动新单元。 */
    private fun stopped(): Boolean = run.cancelRequested || fatal != null

    /** 池线程内读一个单元；读章端口本不抛异常，这里兜住意外以免丢失在途计数。 */
    private fun readUnit(step: Step.Read, snapshot: List<Person>, library: RelationTypeLibrary): ChapterReadResult =
        try {
            reader.read(ChapterReadRequest(step.slot.item.chapter, step.unit, snapshot, library, null, run.control))
        } catch (e: Exception) {
            ChapterReadResult.Failed(ModelFailure.PROVIDER_ERROR, "读章异常：${e.message ?: e.javaClass.simpleName}", ModelCallStats())
        }

    /** 章的第一个单元开始时把章标记为运行中。 */
    private fun begin(slot: Slot) {
        if (slot.started) return
        slot.started = true
        run.updateChapter(slot.item.chapter.id) { it.copy(status = ChapterRunStatus.RUNNING) }
    }

    /** 沿用已存抽取：直接计入结果与滚动人名册，章标记为 REUSED。 */
    private fun reuse(slot: Slot) {
        val stored = checkNotNull(slot.item.reused)
        slot.settled = true
        settled[slot.item.chapter.id] = stored.extraction
        roster = align(stored.extraction)
        run.updateChapter(slot.item.chapter.id) {
            it.copy(status = ChapterRunStatus.REUSED, unitsDone = it.unitsTotal, warnings = stored.warnings)
        }
    }

    /** 吸收一个单元的读章结果：成功则加前缀并对齐更新人名册，失败则记原因；章内单元全部读完或某段失败时结算本章。 */
    private fun absorb(finished: UnitResult) {
        val slot = finished.step.slot
        slot.running = false
        val unit = finished.step.unit
        val label = if (unit.whole) "" else "第${unit.index}/${unit.count}段："
        when (val result = finished.result) {
            is ChapterReadResult.Completed -> {
                val scoped = ReadingUnits.scope(result.extraction, unit)
                roster = align(scoped)
                slot.parts[unit.index] = scoped
                slot.warnings += result.warnings.map { label + it }
            }
            is ChapterReadResult.Failed -> {
                slot.failures += "$label${result.failure}：${result.message}"
                if (result.failure in FATAL_FAILURES) fatal = "${result.failure}：${result.message}"
            }
        }
        slot.done++
        if (slot.failures.isNotEmpty() || slot.done == slot.units.size) settle(slot) else run.updateChapter(slot.item.chapter.id) { it.copy(unitsDone = slot.done) }
    }

    /** 确定性身份对齐（不调模型）：复用明确绑定，把本单元的人物并入人名册快照。 */
    private fun align(extraction: ChapterExtraction): List<Person> =
        IdentityAlignment.start(roster, listOf(extraction)).result().persons

    /** 结算一章：全部单元成功则合并并保存抽取；任一单元失败则整章失败（部分单元的抽取不单独保存）。 */
    private fun settle(slot: Slot) {
        slot.settled = true
        val chapter = slot.item.chapter
        if (slot.failures.isNotEmpty()) return abandon(slot, slot.failures.joinToString("；"))
        val merged = slot.parts.values.singleOrNull()
            ?: ReadingUnits.merge(ExtractionId(UUID.randomUUID().toString()), slot.parts.values.toList())
        try {
            extractions.save(bookId, run.id, merged, slot.warnings)
        } catch (e: Exception) {
            return abandon(slot, "保存章抽取失败：${e.message ?: e.javaClass.simpleName}")
        }
        settled[chapter.id] = merged
        run.updateChapter(chapter.id) { it.copy(status = ChapterRunStatus.DONE, unitsDone = it.unitsTotal, warnings = slot.warnings.toList()) }
    }

    /** 本章没能产出抽取：用户取消记为 CANCELLED，否则记为 FAILED 并写明原因（未启动的章说明阶段被中止的原因）。 */
    private fun abandon(slot: Slot, reason: String? = null) {
        slot.settled = true
        val cancelled = run.cancelRequested
        val error = reason ?: fatal?.let { "已中止：$it" } ?: "未执行"
        run.updateChapter(slot.item.chapter.id) {
            it.copy(status = if (cancelled) ChapterRunStatus.CANCELLED else ChapterRunStatus.FAILED, error = if (cancelled) null else error)
        }
    }

    private companion object {
        /** 出现即意味着后续单元也会失败的错误：鉴权、余额、任务预算耗尽。 */
        val FATAL_FAILURES = setOf(ModelFailure.AUTHENTICATION, ModelFailure.INSUFFICIENT_BALANCE, ModelFailure.BUDGET_EXHAUSTED)
    }
}
