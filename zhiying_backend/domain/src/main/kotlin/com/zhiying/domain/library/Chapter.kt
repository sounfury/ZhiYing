package com.zhiying.domain.library

/**
 * 书中的一章：阅读顺序、标题与某一修订版本的正文。
 *
 * 正文坐标统一使用 UTF-16 代码单元（即 Kotlin `String` 下标），与旧 Python 按码点计的位置不通用。
 */
class Chapter(
    val id: ChapterId,
    val bookId: BookId,
    val order: Int,
    val title: String,
    val revision: TextRevision,
    val text: String,
) {
    init {
        require(order >= 0) { "章节顺序不能为负" }
    }

    /** 创建属于本章当前正文的区间 [start, end)；越界或切开补充平面字符时报错。 */
    fun span(start: Int, end: Int): TextSpan {
        require(end <= text.length) { "区间终点 $end 超出正文长度 ${text.length}" }
        require(!splitsCharacter(start) && !splitsCharacter(end)) { "区间不能切开补充平面字符" }
        return TextSpan(id, revision, start, end)
    }

    /** 读取区间对应的原文；区间必须来自本章的当前正文版本。 */
    fun read(span: TextSpan): String {
        require(span.chapterId == id && span.revision == revision) { "区间不属于本章当前正文" }
        require(span.end <= text.length) { "区间终点 ${span.end} 超出正文长度 ${text.length}" }
        return text.substring(span.start, span.end)
    }

    /**
     * 在正文中定位一段摘录。
     *
     * 全文唯一时直接采用；出现多次时用 [at]（期望起点）选定其中一处，
     * 选不出来就返回全部位置交给调用方——不能仅因同一句出现两次就判为无效。
     */
    fun locate(excerpt: String, at: Int? = null): ExcerptLookup {
        require(excerpt.isNotEmpty()) { "摘录不能为空" }
        val occurrences = occurrencesOf(excerpt)
        val chosen = occurrences.singleOrNull() ?: occurrences.firstOrNull { it.start == at }
        return when {
            chosen != null -> ExcerptLookup.Found(chosen)
            occurrences.isEmpty() -> ExcerptLookup.NotFound
            else -> ExcerptLookup.Ambiguous(occurrences)
        }
    }

    /** 列出摘录在正文中的全部出现位置，允许相互重叠。 */
    private fun occurrencesOf(excerpt: String): List<TextSpan> =
        generateSequence(text.indexOf(excerpt).takeIf { it >= 0 }) { previous ->
            text.indexOf(excerpt, previous + 1).takeIf { it >= 0 }
        }.map { start -> span(start, start + excerpt.length) }.toList()

    /** 该下标是否落在一个补充平面字符（UTF-16 代理对）的中间。 */
    private fun splitsCharacter(index: Int): Boolean =
        index in 1 until text.length && text[index].isLowSurrogate() && text[index - 1].isHighSurrogate()
}
