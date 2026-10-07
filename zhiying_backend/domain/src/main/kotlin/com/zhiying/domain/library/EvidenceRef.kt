package com.zhiying.domain.library

/**
 * 一条判断的依据（本期基础证据模式）：来源章节 + 非空说明，可附若干原文片段。
 *
 * 片段各自独立保存、不拼接；没有片段时就是纯说明依据，不代表"定位成功"。
 * 片段的真实性在提交时由 [Chapter.locate] 核实，这里只保证它们与证据属于同一章。
 */
data class EvidenceRef(
    val id: EvidenceId,
    val chapterId: ChapterId,
    val note: String,
    val quotes: List<TextSpan> = emptyList(),
) {
    init {
        require(note.isNotBlank()) { "证据说明不能为空" }
        require(quotes.all { it.chapterId == chapterId }) { "原文片段必须来自证据所属章节" }
    }

    /** 是否附有原文片段。 */
    val quoted: Boolean get() = quotes.isNotEmpty()
}
