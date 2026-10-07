// 章阅读的基础设施实现：为每章创建本章会话与工具，用工具循环执行器驱动模型读完并提交，再把会话产出汇成结果。
// 步数、预算、重试、用量由执行器负责；规则校验在 ChapterSession；这里只做装配与收尾。
package com.zhiying.infrastructure.llm.reading

import com.zhiying.application.analyze.reading.ChapterReadRequest
import com.zhiying.application.analyze.reading.ChapterReadResult
import com.zhiying.application.analyze.reading.ChapterReader
import com.zhiying.application.diagnostics.ModelFailure
import com.zhiying.application.llm.ModelCallBudget
import com.zhiying.application.llm.ModelCallControl
import com.zhiying.domain.extraction.ExtractionProvenance
import com.zhiying.domain.library.TextRevision
import com.zhiying.infrastructure.config.ZhiYingProperties
import com.zhiying.infrastructure.llm.LoopEnd
import com.zhiying.infrastructure.llm.ModelInvoker
import com.zhiying.infrastructure.llm.ToolLoopExecutor
import com.zhiying.infrastructure.llm.ToolLoopOutcome
import com.zhiying.infrastructure.llm.ToolLoopRequest
import org.slf4j.LoggerFactory
import org.springframework.stereotype.Component

/** 基于 Spring AI 工具循环的章阅读器。 */
@Component
class SpringAiChapterReader(
    private val loop: ToolLoopExecutor,
    private val invoker: ModelInvoker,
    properties: ZhiYingProperties,
) : ChapterReader {
    private val config = properties.reading
    private val log = LoggerFactory.getLogger(SpringAiChapterReader::class.java)

    /**
     * 读取一章。
     *
     * 入参：[request] 章节、人名册、类型库、可选前文摘要与任务级控制。
     * 出参：[ChapterReadResult.Completed]（含警告）或 [ChapterReadResult.Failed]；不抛出模型调用异常。
     */
    override fun read(request: ChapterReadRequest): ChapterReadResult {
        // 流程：确定本次负责的区间 → 建会话与工具 → 构造提示 → 跑工具循环 → 按结束方式收尾并产出领域对象
        val chapter = request.chapter
        val unit = request.unit
        val range = unit?.let { it.start until it.end } ?: (0 until chapter.text.length)
        val injectUnit = range.last - range.first + 1 <= config.injectMaxChars
        val session = ChapterSession(chapter, request.roster, request.library, config.readWindowChars, range, injectUnit)
        val outcome = loop.run(
            ToolLoopRequest(
                system = ChapterReadingPrompts.system(config.readWindowChars),
                user = ChapterReadingPrompts.user(
                    chapter, unit, request.roster, request.library, request.priorSummary,
                    config.injectMaxChars, config.readWindowChars, config.segmentHintChars,
                ),
                tools = ChapterTools.of(session),
                maxSteps = maxStepsFor(range.last - range.first + 1),
                model = config.model.ifBlank { null },
                thinking = config.thinking,
                control = chapterControl(request.control),
                nudge = SUBMIT_NUDGE,
                nudges = config.submitNudges,
                isDone = { session.submitted },
            ),
        )
        logUsage(request, range.last - range.first + 1, outcome)
        return finish(session, outcome, request)
    }

    /** 记录一个阅读单元的用量与耗时（章、段、字数、请求数、输入 / 输出 token、毫秒），用于估算成本与时长。 */
    private fun logUsage(request: ChapterReadRequest, chars: Int, outcome: ToolLoopOutcome) {
        val stats = outcome.stats
        val part = request.unit?.let { "${it.index}/${it.count}" } ?: "1/1"
        log.info(
            "读章用量 chapter={} 「{}」 unit={} chars={} steps={} requests={} input={} output={} elapsedMs={} end={}",
            request.chapter.order, request.chapter.title, part, chars, outcome.steps, stats.requests,
            stats.usage.input, stats.usage.output, stats.elapsedMillis, outcome.end::class.simpleName,
        )
    }

    /** 当前所用模型（章阅读专用模型，空则取默认）与提示词版本。 */
    override fun provenanceFor(textRevision: TextRevision) =
        ExtractionProvenance(textRevision, config.model.ifBlank { invoker.defaultModel() }, ChapterReadingPrompts.VERSION)

    /** 单章预算挂在任务级预算之下，两级都受限；取消信号沿用任务级。 */
    private fun chapterControl(task: ModelCallControl) =
        task.copy(budget = ModelCallBudget(config.maxRequests, config.maxTokens, parent = task.budget))

    /** 短章用基础步数；长章按 15 + 2 × 窗数估算，不超过上限（15 为读窗之外的取证、登记、提交步数）。 */
    private fun maxStepsFor(chars: Int): Int {
        if (chars <= config.injectMaxChars) return config.baseSteps
        val windows = (chars + config.readWindowChars - 1) / config.readWindowChars
        return minOf(config.maxSteps, LONG_CHAPTER_BASE_STEPS + 2 * windows)
    }

    /** 按循环结束方式收尾：已提交直接产出；模型停手或步数用尽时，有累积成果则程序收尾并带警告，否则报失败。 */
    private fun finish(session: ChapterSession, outcome: ToolLoopOutcome, request: ChapterReadRequest): ChapterReadResult {
        val needsFinalize = when (val end = outcome.end) {
            is LoopEnd.Failed -> return ChapterReadResult.Failed(end.failure, end.message, outcome.stats)
            LoopEnd.Finished -> false
            LoopEnd.ModelStopped -> true
            LoopEnd.StepsExhausted -> {
                if (!session.hasWork()) {
                    return ChapterReadResult.Failed(ModelFailure.STEPS_EXHAUSTED, "用尽 ${outcome.steps} 步仍未登记任何内容", outcome.stats)
                }
                true
            }
        }
        if (needsFinalize) session.finalizeWithoutSubmit(outcome.lastText.take(SUMMARY_FALLBACK_CHARS))
        return try {
            val provenance = provenanceFor(request.chapter.revision)
            val extraction = session.build(provenance.model, provenance.promptVersion)
            ChapterReadResult.Completed(extraction, outcome.stats, session.warnings())
        } catch (e: IllegalArgumentException) {
            ChapterReadResult.Failed(ModelFailure.UNEXPECTED_REPLY, "抽取结果违反领域约束：${e.message}", outcome.stats)
        }
    }

    private companion object {
        /** 长章步数估算的基数。 */
        const val LONG_CHAPTER_BASE_STEPS = 15

        /** 程序收尾时，取模型最后文字回复的前若干字作摘要。 */
        const val SUMMARY_FALLBACK_CHARS = 2000

        /** 模型不调工具也未提交时的提醒。 */
        const val SUBMIT_NUDGE =
            "你刚才没有调用任何工具，纯文本不会写入结果。若人物、关系、交流已提交完毕，请立即调用 submit_result(summary) 结束本章；" +
                "若尚未提交，请先 register_persons / submit_relations / submit_interactions，最后必须调用 submit_result。" +
                "即使本章很短、出场很少，也必须调用 submit_result。"
    }
}
