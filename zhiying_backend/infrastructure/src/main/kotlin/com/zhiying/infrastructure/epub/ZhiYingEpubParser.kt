// EPUB 解析适配：实现应用层 EpubParser，串起容器读取、切章、字数统计与「是否参与分析」判定。
package com.zhiying.infrastructure.epub

import com.zhiying.application.error.AppException
import com.zhiying.application.error.ErrorCode
import com.zhiying.application.importbook.EpubParser
import com.zhiying.application.importbook.ParsedBook
import com.zhiying.application.importbook.ParsedChapter
import com.zhiying.domain.library.ChapterInclusion
import com.zhiying.infrastructure.config.ZhiYingProperties
import org.springframework.stereotype.Component

/** 基于 jsoup 的 EPUB 解析器；纯内存，不写盘。 */
@Component
class ZhiYingEpubParser(properties: ZhiYingProperties) : EpubParser {
    private val settings = properties.`import`
    private val splitter = ChapterSplitter(settings.maxTitleLineLength)

    /**
     * 解析 EPUB：按 spine 顺序逐份切章，统计字数并判定是否参与分析。
     * 短章保留在书中并标记「过短」（旧实现直接丢弃）；没有任何参与分析的章节时抛 UNREADABLE_BOOK。
     */
    override fun parse(content: ByteArray): ParsedBook {
        val contents = EpubArchive.read(content)
        val chapters = contents.documents.flatMap(splitter::split).map { raw ->
            val words = countWords(raw.text)
            ParsedChapter(
                raw.title, raw.text, words, raw.href,
                ChapterInclusion.judge(raw.title, raw.text, words, settings.minChapterWords),
            )
        }
        if (chapters.none { it.inclusion.included }) {
            throw AppException(ErrorCode.UNREADABLE_BOOK, "无有效章节：所有章节都低于 ${settings.minChapterWords} 字或属于非正文")
        }
        return ParsedBook(contents.title, contents.author, chapters)
    }

    /** 字数统计：CJK 汉字按字计，连续英文字母序列按一词计。 */
    private fun countWords(text: String): Int =
        text.count { it in '一'..'鿿' || it in '㐀'..'䶿' } + ENGLISH_WORD.findAll(text).count()

    private companion object {
        val ENGLISH_WORD = Regex("[a-zA-Z]+")
    }
}
