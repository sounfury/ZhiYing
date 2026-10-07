package com.zhiying.domain.library

/**
 * 正文中的半开区间 [start, end)，坐标单位为 UTF-16 代码单元。
 *
 * 携带章节与正文修订号：正文修订后，旧区间不会被误读成新正文中的另一段文字。
 * 与具体正文长度相关的校验在 [Chapter.span] 与 [Chapter.read] 中完成。
 */
data class TextSpan(
    val chapterId: ChapterId,
    val revision: TextRevision,
    val start: Int,
    val end: Int,
) {
    init {
        require(start >= 0) { "区间起点不能为负" }
        require(start < end) { "区间起点必须小于终点" }
    }
}

/** 摘录定位结果。定位失败属于输入错误，应在工具调用当场反馈修正，不进入语义判断。 */
sealed interface ExcerptLookup {
    /** 唯一确定的位置。 */
    data class Found(val span: TextSpan) : ExcerptLookup

    /** 正文中没有这段文字。 */
    data object NotFound : ExcerptLookup

    /** 出现多次且给出的位置无法选定其中一处；附全部出现位置供选择。 */
    data class Ambiguous(val occurrences: List<TextSpan>) : ExcerptLookup
}
