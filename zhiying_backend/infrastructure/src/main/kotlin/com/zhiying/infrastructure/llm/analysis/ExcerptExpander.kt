// 原文片段扩展：在章节正文上按句、段落、对话边界做有界扩展，供补查取上下文；纯文本算法，不做任何读取。
package com.zhiying.infrastructure.llm.analysis

import com.zhiying.domain.relations.RecheckAction
import com.zhiying.infrastructure.config.RecheckContextProperties

/** 正文中的半开区间 [start, end)。 */
internal data class Window(val start: Int, val end: Int) {
    /** 区间长度。 */
    val length: Int get() = end - start
}

/**
 * 正文的段落与句子切分。
 *
 * 段落按换行切分并跳过空行；句子以句末标点（含其后紧跟的引号括号）或换行为界。对话段落指以引号开头的段落。
 */
internal class ChapterSegments(private val text: String) {
    /** 非空段落的区间。 */
    val paragraphs: List<Window> = buildParagraphs()

    private fun buildParagraphs(): List<Window> {
        val result = mutableListOf<Window>()
        var start = 0
        while (start <= text.length) {
            val newline = text.indexOf('\n', start).let { if (it < 0) text.length else it }
            if (text.substring(start, newline).isNotBlank()) result += Window(start, newline)
            start = newline + 1
        }
        return result
    }

    /** 包含 [position] 的段落序号；落在段落之间时取前一个段落。 */
    fun paragraphAt(position: Int): Int {
        val index = paragraphs.indexOfLast { it.start <= position }
        return index.coerceAtLeast(0)
    }

    /** 第 [index] 个段落是否是对话（以引号开头）。 */
    fun isDialogue(index: Int): Boolean = text.substring(paragraphs[index].start, paragraphs[index].end).trimStart().firstOrNull() in OPENERS

    /** 包含位置 [position] 的句子的起点。 */
    fun sentenceStart(position: Int): Int {
        var i = position
        while (i > 0) {
            val c = text[i - 1]
            val afterTerminator = c in CLOSERS && i >= 2 && text[i - 2] in TERMINATORS
            if (c == '\n' || c in TERMINATORS || afterTerminator) break
            i--
        }
        return i
    }

    /** 以 [end] 为区间终点的区间所在句子的终点（含句末标点与其后的引号括号）。 */
    fun sentenceEnd(end: Int): Int {
        var i = (end - 1).coerceAtLeast(0)
        while (i < text.length) {
            val c = text[i]
            i++
            if (c == '\n') return i - 1
            if (c in TERMINATORS) {
                while (i < text.length && text[i] in CLOSERS) i++
                break
            }
        }
        return i
    }

    /** [start] 之前紧邻的那个句子的起点；前面没有更多文字时返回 null。 */
    fun previousSentenceStart(start: Int): Int? {
        var j = start
        while (j > 0 && text[j - 1].isWhitespace()) j--
        if (j == 0) return null
        var i = j
        while (i > 0 && text[i - 1] in CLOSERS) i--
        if (i > 0 && text[i - 1] in TERMINATORS) i--
        return sentenceStart(i)
    }

    /** [end] 之后紧邻的那个句子的终点；后面没有更多文字时返回 null。 */
    fun nextSentenceEnd(end: Int): Int? {
        var j = end
        while (j < text.length && text[j].isWhitespace()) j++
        if (j >= text.length) return null
        return sentenceEnd(j + 1)
    }

    /** 把区间端点调整到不切开补充平面字符。 */
    fun aligned(window: Window): Window {
        var start = window.start
        var end = window.end
        if (start in 1 until text.length && text[start].isLowSurrogate()) start++
        if (end in 1 until text.length && text[end].isLowSurrogate()) end--
        return Window(start, maxOf(start, end))
    }

    private companion object {
        val TERMINATORS = setOf('。', '！', '？', '!', '?', '…', '；', ';')
        val CLOSERS = setOf('”', '」', '』', '’', '）', ')', '"', '》')
        val OPENERS = setOf('“', '「', '『', '‘', '"')
    }
}

/**
 * 按补查动作扩展证据片段的窗口，所有上限来自 [RecheckContextProperties]。
 *
 * 起点是证据所在的句子，随后按动作扩展到段落、相邻段落或对话边界；窗口超过单片段字符上限时，
 * 回到所在句，再以句为单位向前后交替扩展，直到放不下为止。
 */
internal class ExcerptExpander(text: String, private val limits: RecheckContextProperties) {
    private val segments = ChapterSegments(text)

    /** 正文是否没有任何段落。 */
    val isEmpty: Boolean get() = segments.paragraphs.isEmpty()

    /**
     * 为 [span] 计算 [action] 对应的上下文窗口。
     * 动作含义：指代不明按对话边界向前追溯说话者、向后看回应；类型 / 方向含糊只取所在段落；
     * 片段不足取所在段落及前后若干段；比喻 / 传闻取所在段落及前后各一段。
     */
    fun windowFor(span: Window, action: RecheckAction): Window {
        val first = segments.paragraphAt(span.start)
        val last = segments.paragraphAt(span.end - 1).coerceAtLeast(first)
        val (from, to) = paragraphRange(first, last, action)
        val full = Window(segments.paragraphs[from].start, segments.paragraphs[to].end)
        val widened = Window(minOf(full.start, span.start), maxOf(full.end, span.end))
        return segments.aligned(if (widened.length <= limits.maxExcerptChars) widened else shrink(widened, span))
    }

    /** 动作对应的段落范围（含两端）。 */
    private fun paragraphRange(first: Int, last: Int, action: RecheckAction): Pair<Int, Int> {
        val maxIndex = segments.paragraphs.lastIndex
        return when (action) {
            RecheckAction.RESTATE_TYPE_AND_ROLES -> first to last
            RecheckAction.PROBE_DOUBT -> {
                val n = minOf(1, limits.neighborParagraphs)
                (first - n).coerceAtLeast(0) to (last + n).coerceAtMost(maxIndex)
            }
            RecheckAction.EXPAND_CONTEXT ->
                (first - limits.neighborParagraphs).coerceAtLeast(0) to (last + limits.neighborParagraphs).coerceAtMost(maxIndex)
            RecheckAction.ENRICH_REFERENCE_CONTEXT -> dialogueRange(first, last)
        }
    }

    /** 对话边界：向前连续追溯发言直到遇到叙述段（通常交代了说话者），向后同理，各自有段数上限。 */
    private fun dialogueRange(first: Int, last: Int): Pair<Int, Int> {
        var from = first
        var steps = 0
        while (from > 0 && steps < limits.dialogueMaxParagraphs) {
            from--
            steps++
            if (!segments.isDialogue(from)) break
        }
        var to = last
        steps = 0
        while (to < segments.paragraphs.lastIndex && steps < limits.dialogueMaxParagraphs) {
            to++
            steps++
            if (!segments.isDialogue(to)) break
        }
        return from to to
    }

    /** 超长窗口收缩：从证据所在句开始，以句为单位向前后交替扩展，不超过字符上限也不越出 [full]。 */
    private fun shrink(full: Window, evidence: Window): Window {
        val cap = limits.maxExcerptChars
        var lo = maxOf(full.start, segments.sentenceStart(evidence.start))
        var hi = minOf(full.end, segments.sentenceEnd(evidence.end))
        if (hi - lo > cap) {
            // 证据句本身就超长：以证据中点为中心硬截
            val mid = (evidence.start + evidence.end) / 2
            lo = maxOf(full.start, mid - cap / 2)
            hi = minOf(full.end, lo + cap)
            return Window(maxOf(full.start, hi - cap), hi)
        }
        do {
            var grew = false
            val before = segments.previousSentenceStart(lo)
            if (before != null && before < lo && before >= full.start && hi - before <= cap) {
                lo = before
                grew = true
            }
            val after = segments.nextSentenceEnd(hi)
            if (after != null && after > hi && after <= full.end && after - lo <= cap) {
                hi = after
                grew = true
            }
        } while (grew)
        return Window(lo, hi)
    }
}
