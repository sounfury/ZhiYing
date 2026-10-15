// TXT 解析适配：实现应用层 TxtParser，负责编码识别、清洗、按预置分章方案切章（自动选择或指定）与方案预览。
package com.zhiying.infrastructure.txt

import com.zhiying.application.error.AppException
import com.zhiying.application.error.ErrorCode
import com.zhiying.application.importbook.ParsedBook
import com.zhiying.application.importbook.ParsedChapter
import com.zhiying.application.importbook.SplitPreview
import com.zhiying.application.importbook.TxtParser
import com.zhiying.domain.library.ChapterInclusion
import com.zhiying.infrastructure.config.ZhiYingProperties
import com.zhiying.infrastructure.epub.countWords
import org.springframework.stereotype.Component
import tools.jackson.module.kotlin.jacksonObjectMapper
import tools.jackson.module.kotlin.readValue
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.Charset
import java.nio.charset.CodingErrorAction

/**
 * 资源文件 txt-toc-rules.json 中的一条分章方案。id 一经发布不改；要改正则就新建 id。
 * [extra] 为卷标题、楔子等附加标题；有 [extra] 的方案在自动选择时要求它至少命中一次。
 */
internal data class TocRule(
    val id: String = "",
    val name: String = "",
    val example: String = "",
    val rule: String = "",
    val extra: String? = null,
)

private class Scheme(
    val rule: TocRule,
) {
    val title = Regex(rule.rule)
    val extra = rule.extra?.let(::Regex)
}

/** 一次试切：(标题, 正文) 列表与附加标题命中次数。 */
private class Split(
    val chapters: List<Pair<String, String>>,
    val extraHits: Int,
)

private enum class Heading { TITLE, EXTRA }

/** 纯内存解析，不写盘。 */
@Component
class TxtBookParser(
    properties: ZhiYingProperties,
) : TxtParser {
    private val settings = properties.`import`
    private val schemes: List<Scheme> =
        jacksonObjectMapper()
            .readValue<List<TocRule>>(
                requireNotNull(javaClass.getResourceAsStream("/txt-toc-rules.json")) { "缺少 txt-toc-rules.json" }
                    .bufferedReader()
                    .use { it.readText() },
            ).map(::Scheme)
    private val lengthRule = TocRule(LENGTH, "按长度分段", "约 ${settings.txtSegmentChars} 字一段")

    override fun parse(
        content: ByteArray,
        rule: String?,
    ): ParsedBook {
        val (id, raw) = chaptersFor(lines(content), rule)
        val chapters =
            raw.mapIndexed { i, (title, text) ->
                val words = countWords(text)
                ParsedChapter(title, text, words, "txt#${i + 1}", ChapterInclusion.judge(title, text, words, settings.minChapterWords))
            }
        if (chapters.none { it.inclusion.included }) {
            throw AppException(ErrorCode.UNREADABLE_BOOK, "无有效章节：所有章节都低于 ${settings.minChapterWords} 字或属于非正文")
        }
        // 书名由调用方取文件名
        return ParsedBook(null, null, chapters, id)
    }

    override fun preview(
        content: ByteArray,
        currentRule: String,
    ): List<SplitPreview> {
        val lines = lines(content)
        return schemes.map { sample(it.rule, split(lines, it).chapters.map { c -> c.first }, currentRule) } +
            sample(lengthRule, byLength(lines).map { it.first }, currentRule)
    }

    /** 指定方案或自动选择；出参：(方案 id, 章列表)。 */
    private fun chaptersFor(
        lines: List<String>,
        rule: String?,
    ): Pair<String, List<Pair<String, String>>> {
        if (rule == null) return auto(lines)
        if (rule == LENGTH) return LENGTH to byLength(lines)
        val scheme = schemes.firstOrNull { it.rule.id == rule } ?: throw AppException(ErrorCode.INVALID_ARGUMENT, "未知的分章方案：$rule")
        return rule to split(lines, scheme).chapters
    }

    /** 按资源文件顺序取第一个合适的方案，不取命中最多的（数字序号类会把正文列表也算进去）；都不合适按长度分段。 */
    private fun auto(lines: List<String>): Pair<String, List<Pair<String, String>>> {
        for (scheme in schemes) {
            val split = split(lines, scheme)
            if (fits(scheme, split)) return scheme.rule.id to split.chapters
        }
        return LENGTH to byLength(lines)
    }

    private fun fits(
        scheme: Scheme,
        split: Split,
    ): Boolean {
        val n = split.chapters.size
        if (n < 2 || (scheme.extra != null && split.extraHits == 0)) return false
        return split.chapters.sumOf { it.second.length } / n in settings.txtAutoMinChars..settings.txtAutoMaxChars
    }

    /**
     * 按标题行切章：首个标题前的内容为「开篇」；连续标题（卷标题、只有标题没有正文的章）拼到下一章标题上；
     * 结尾没有正文的标题丢弃。正文段落去掉缩进后以空行分隔。
     */
    private fun split(
        lines: List<String>,
        scheme: Scheme,
    ): Split {
        val chapters = mutableListOf<Pair<String, String>>()
        val headings = mutableListOf<String>()
        val body = mutableListOf<String>()
        var extraHits = 0

        fun flush() {
            if (body.isEmpty()) return
            chapters += headings.joinToString(" · ").ifEmpty { OPENING } to body.joinToString("\n\n")
            headings.clear()
            body.clear()
        }
        for (line in lines) {
            val title = titleOf(line)
            val kind = title?.let { kindOf(it, scheme) }
            if (title == null || kind == null) {
                line.trim().takeIf { it.isNotEmpty() }?.let(body::add)
                continue
            }
            flush()
            headings += title
            if (kind == Heading.EXTRA) extraHits++
        }
        flush()
        return Split(chapters, extraHits)
    }

    /** 抗误报：标题独占一行，行首全角空格缩进视为正文；去缩进后不超过 35 字；以句号、问号结尾的不算。 */
    private fun titleOf(line: String): String? {
        val text = line.trimStart(' ', '\t')
        if (text.startsWith('\u3000')) return null
        return text.trim().takeIf { it.isNotEmpty() && it.length <= MAX_TITLE && it.last() !in "。？?" }
    }

    private fun kindOf(
        title: String,
        scheme: Scheme,
    ): Heading? =
        when {
            scheme.extra?.containsMatchIn(title) == true -> Heading.EXTRA
            scheme.title.containsMatchIn(title) -> Heading.TITLE
            else -> null
        }

    /** 约 txtSegmentChars 字一段，在段落边界切开；末段不足半段时并入上一段。 */
    private fun byLength(lines: List<String>): List<Pair<String, String>> {
        val segments = mutableListOf(mutableListOf<String>())
        var size = 0
        for (paragraph in lines.map { it.trim() }.filter { it.isNotEmpty() }) {
            if (size >= settings.txtSegmentChars) {
                segments += mutableListOf<String>()
                size = 0
            }
            segments.last() += paragraph
            size += paragraph.length
        }
        if (segments.size > 1 &&
            size < settings.txtSegmentChars / 2
        ) {
            segments[segments.lastIndex - 1] += segments.removeAt(segments.lastIndex)
        }
        return segments.filter { it.isNotEmpty() }.mapIndexed { i, s -> "第 ${i + 1} 段" to s.joinToString("\n\n") }
    }

    /** 开头、中间、结尾各取 SAMPLE 个标题，互不重叠。 */
    private fun sample(
        rule: TocRule,
        titles: List<String>,
        currentRule: String,
    ): SplitPreview {
        val headEnd = minOf(SAMPLE, titles.size)
        val tailStart = maxOf(headEnd, titles.size - SAMPLE)
        val rest = titles.subList(headEnd, tailStart)
        val middle = rest.drop(maxOf(0, (rest.size - SAMPLE) / 2)).take(SAMPLE)
        return SplitPreview(
            rule.id,
            rule.name,
            rule.example,
            titles.size,
            titles.take(headEnd),
            middle,
            titles.drop(tailStart),
            rule.id == currentRule,
        )
    }

    /** 解码并统一换行、去行尾空白。 */
    private fun lines(content: ByteArray): List<String> =
        decode(content)
            .replace("\r\n", "\n")
            .replace('\r', '\n')
            .split('\n')
            .map { it.trimEnd() }

    /**
     * 有 BOM 按 BOM；否则严格 UTF-8，失败再 GB18030；都失败或含 NUL（多半是二进制文件改了扩展名）抛 UNREADABLE_BOOK。
     * shortcut: 不识别 Big5（GB18030 解 Big5 不报错只出乱码），遇到繁体书源再加中文字符比例检测。
     */
    private fun decode(content: ByteArray): String {
        val text =
            when {
                content.startsWith(0xEF, 0xBB, 0xBF) -> String(content, 3, content.size - 3, Charsets.UTF_8)
                content.startsWith(0xFF, 0xFE) -> String(content, 2, content.size - 2, Charsets.UTF_16LE)
                content.startsWith(0xFE, 0xFF) -> String(content, 2, content.size - 2, Charsets.UTF_16BE)
                else -> strict(content, Charsets.UTF_8) ?: strict(content, Charset.forName("GB18030"))
            }
        if (text == null || '\u0000' in text) throw AppException(ErrorCode.UNREADABLE_BOOK, "无法识别 TXT 的文字编码")
        return text
    }

    private fun strict(
        content: ByteArray,
        charset: Charset,
    ): String? =
        try {
            charset
                .newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(content))
                .toString()
        } catch (_: CharacterCodingException) {
            null
        }

    private fun ByteArray.startsWith(vararg bytes: Int) = size >= bytes.size && bytes.indices.all { this[it] == bytes[it].toByte() }

    private companion object {
        const val LENGTH = "length"
        const val OPENING = "开篇"
        const val MAX_TITLE = 35
        const val SAMPLE = 3
    }
}
