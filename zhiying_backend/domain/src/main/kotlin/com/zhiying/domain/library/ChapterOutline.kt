// 章节概要与全书画像：不含正文的章节信息，以及据此汇总的字数统计。
package com.zhiying.domain.library

/**
 * 章节概要（不含正文），用于列表与分析范围决策。
 *
 * 入参：[order] 从 1 开始的阅读序号；[wordCount] 字数（中文按字、英文按词）；[sourceHref] 章节来自 EPUB 中的哪个文件；
 * [inclusion] 是否参与分析及原因。
 */
data class ChapterOutline(
    val id: ChapterId,
    val bookId: BookId,
    val order: Int,
    val title: String,
    val wordCount: Int,
    val sourceHref: String,
    val inclusion: ChapterInclusion,
) {
    init {
        require(order >= 1) { "章节序号从 1 开始" }
        require(wordCount >= 0) { "字数不能为负" }
    }
}

/** 全书画像：章数与字数分布，导入时由章节概要汇总得到。 */
data class BookProfile(
    val totalChapters: Int,
    val analysisChapters: Int,
    val totalWords: Int,
    val maxChapterWords: Int,
    val medianChapterWords: Int,
) {
    companion object {
        /** 由章节概要汇总画像；没有章节时各项为 0。 */
        fun of(chapters: List<ChapterOutline>): BookProfile {
            val words = chapters.map { it.wordCount }.sorted()
            return BookProfile(
                totalChapters = chapters.size,
                analysisChapters = chapters.count { it.inclusion.included },
                totalWords = words.sum(),
                maxChapterWords = words.lastOrNull() ?: 0,
                medianChapterWords = if (words.isEmpty()) 0 else (words[(words.size - 1) / 2] + words[words.size / 2]) / 2,
            )
        }
    }
}
