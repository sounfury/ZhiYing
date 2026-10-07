// 补查上下文提供者：读取证据所在章节正文，从证据原句出发按补查动作做有界扩展，产出带标记的原文片段。
package com.zhiying.infrastructure.llm.analysis

import com.zhiying.application.analyze.relations.ContextExcerpt
import com.zhiying.application.analyze.relations.RecheckContextProvider
import com.zhiying.application.library.BookRepository
import com.zhiying.domain.library.Chapter
import com.zhiying.domain.relations.RecheckAction
import com.zhiying.domain.relations.RelationOccurrence
import com.zhiying.infrastructure.config.ZhiYingProperties
import org.springframework.stereotype.Component

/**
 * 基于章节正文的补查上下文提供者。
 *
 * 副作用：通过 [BookRepository.findChapter] 读取章节正文（每条记录一次）。
 * 只使用带原文区间的证据；区间必须属于章节当前正文版本，过期或越界的区间跳过。没有可定位的证据时返回空列表，
 * 由补查提示说明"没有取得原文片段"，不伪造上下文。证据原句在片段中以 ⟦ ⟧ 标出。
 */
@Component
class ChapterRecheckContextProvider(
    private val books: BookRepository,
    properties: ZhiYingProperties,
) : RecheckContextProvider {
    private val limits = properties.postProcess.recheckContext

    /**
     * 为一条未决记录取补查所需的原文片段。
     * 入参：[occurrence] 未决记录；[action] 补查动作，决定扩展方式。出参：不超过上限条数的片段。
     */
    override fun contextFor(occurrence: RelationOccurrence, action: RecheckAction): List<ContextExcerpt> {
        // 流程：读章 → 筛出可用区间 → 逐区间扩展成窗口 → 合并相邻窗口 → 截断条数 → 标出证据原句
        val chapter = books.findChapter(occurrence.chapterId) ?: return emptyList()
        val spans = usableSpans(chapter, occurrence)
        if (spans.isEmpty()) return emptyList()
        val expander = ExcerptExpander(chapter.text, limits)
        if (expander.isEmpty) return emptyList()
        val windows = merge(spans.map { expander.windowFor(it, action) }).take(limits.maxExcerpts)
        return windows.map { window -> ContextExcerpt(chapter.id, marked(chapter.text, window, spans)) }
    }

    /** 属于本章当前正文版本且未越界的证据区间，按位置排序。 */
    private fun usableSpans(chapter: Chapter, occurrence: RelationOccurrence): List<Window> =
        occurrence.evidence.flatMap { it.quotes }
            .filter { it.chapterId == chapter.id && it.revision == chapter.revision && it.end <= chapter.text.length }
            .map { Window(it.start, it.end) }
            .distinct()
            .sortedBy { it.start }

    /** 合并重叠或相邻、且合并后不超过单片段上限的窗口。 */
    private fun merge(windows: List<Window>): List<Window> {
        val merged = mutableListOf<Window>()
        for (window in windows.sortedBy { it.start }) {
            val last = merged.lastOrNull()
            val joined = last?.let { Window(it.start, maxOf(it.end, window.end)) }
            if (last != null && window.start <= last.end && joined!!.length <= limits.maxExcerptChars) {
                merged[merged.lastIndex] = joined
            } else {
                merged += window
            }
        }
        return merged
    }

    /** 取窗口内的原文，并用 ⟦ ⟧ 标出落在其中的证据区间（重叠的区间先合并）。 */
    private fun marked(text: String, window: Window, spans: List<Window>): String {
        val inside = spans.filter { it.start >= window.start && it.end <= window.end }
        val combined = mutableListOf<Window>()
        for (span in inside) {
            val last = combined.lastOrNull()
            if (last != null && span.start <= last.end) combined[combined.lastIndex] = Window(last.start, maxOf(last.end, span.end)) else combined += span
        }
        val out = StringBuilder(text.substring(window.start, window.end))
        for (span in combined.asReversed()) {
            out.insert(span.end - window.start, "⟧")
            out.insert(span.start - window.start, "⟦")
        }
        return out.toString().trim()
    }
}
