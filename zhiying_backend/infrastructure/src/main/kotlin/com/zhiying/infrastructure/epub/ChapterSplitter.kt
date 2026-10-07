// 章节切分：把一份 spine 文档的 HTML 清洗成纯文本，并按「heading → 章节标记正则 → 整份一章」分层降级切章。
package com.zhiying.infrastructure.epub

import org.jsoup.Jsoup
import org.jsoup.nodes.Element
import org.jsoup.nodes.Node
import org.jsoup.nodes.TextNode
import java.io.ByteArrayInputStream

/** 切出的一章原始内容：标题、清洗后的正文、来源文件。 */
internal class RawChapter(val title: String, val text: String, val href: String)

/**
 * 章节切分器。
 *
 * 入参：[maxTitleLineLength] 正则切章时，标记所在行不超过此长度就整行作标题。
 */
internal class ChapterSplitter(private val maxTitleLineLength: Int) {

    private companion object {
        const val UNTITLED = "未命名"

        /** 结尾补段落换行的块级标签（旧实现只处理 p/div/br，这里补上标题、列表等，避免文字粘连）。 */
        val BLOCK_TAGS = setOf("p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "li", "blockquote", "tr")

        /** 章节标记：行首的「第X章/回/节/卷」与「Chapter N」，按此顺序尝试，命中 2 处以上才切分。 */
        val CHAPTER_MARKERS = listOf(
            Regex("^[ \t\u3000]*(第[\\d一二三四五六七八九十百千]+[章回节卷])", RegexOption.MULTILINE),
            Regex("^[ \t\u3000]*(Chapter\\s+\\d+)", setOf(RegexOption.MULTILINE, RegexOption.IGNORE_CASE)),
        )
    }

    /**
     * 切分一份文档。
     *
     * 流程：去脚本样式 → 有 2 个以上 h1/h2 按 heading 切 → 恰好 1 个 heading 整份一章（正文里的「第X章」是引用而非边界）
     * → 0 个 heading 才尝试标记正则 → 都不行整份一章。无正文返回空列表。
     */
    fun split(doc: SpineDocument): List<RawChapter> {
        val dom = Jsoup.parse(ByteArrayInputStream(doc.content), null, "")
        dom.select("script, style").remove()
        val body = dom.body()
        val headings = body.select("h1, h2")
        if (headings.size >= 2) return splitByHeadings(body, doc.href)

        val text = normalize(TextCollector(false).apply { collect(body) }.parts.first().toString())
        if (text.isEmpty()) return emptyList()
        val fallbackTitle = doc.tocTitle ?: dom.title().ifBlank { UNTITLED }
        if (headings.size == 1) return listOf(RawChapter(headings[0].text().ifBlank { fallbackTitle }, text, doc.href))
        val chunks = splitByMarkers(text)
        return chunks?.map { (title, chunk) -> RawChapter(title, chunk, doc.href) }
            ?: listOf(RawChapter(fallbackTitle, text, doc.href))
    }

    /** 按 h1/h2 位置切分：标题取 heading 文本，正文取到下一个 heading 之前；第一个 heading 之前的内容和空正文丢弃。 */
    private fun splitByHeadings(body: Element, href: String): List<RawChapter> {
        val collector = TextCollector(true).apply { collect(body) }
        return collector.titles.mapIndexedNotNull { i, title ->
            val text = normalize(collector.parts[i + 1].toString())
            if (text.isEmpty()) null else RawChapter(title.ifBlank { UNTITLED }, text, href)
        }
    }

    /**
     * 用章节标记切分整段文本：某个标记正则命中 2 处以上才切，每章从标记起到下一标记前；标记前的内容丢弃。
     * 出参：(标题, 正文) 列表；不满足切分条件返回 null。
     */
    private fun splitByMarkers(text: String): List<Pair<String, String>>? {
        for (marker in CHAPTER_MARKERS) {
            val matches = marker.findAll(text).map { it.groups[1]!! }.toList()
            if (matches.size < 2) continue
            return matches.mapIndexed { i, group ->
                val start = group.range.first
                val end = matches.getOrNull(i + 1)?.range?.first ?: text.length
                val line = text.substring(start, end).lineSequence().first().trim()
                val title = if (line.length <= maxTitleLineLength) line else group.value.trim()
                title to text.substring(start, end).trim()
            }
        }
        return null
    }

    /** 归一化文本：统一换行、去掉行首行尾的普通空白、压缩多余空行。 */
    private fun normalize(raw: String): String = raw
        .replace("\r\n", "\n").replace('\r', '\n')
        .replace(Regex("[ \t]+\n"), "\n").replace(Regex("\n[ \t]+"), "\n")
        .replace(Regex("\n{3,}"), "\n\n")
        .trim()

    /**
     * HTML 转纯文本的遍历器：文本节点原样拼接，p/div/br 等块级元素后补 `\n\n`。
     * 入参：[splitOnHeadings] 为 true 时遇到 h1/h2 记录标题并另起一段（heading 自身文本不进正文）。
     * 结果：[parts]（第 0 段是首个 heading 之前的内容）与 [titles]（第 i 个标题对应 parts[i+1]）。
     */
    private class TextCollector(private val splitOnHeadings: Boolean) {
        val parts = mutableListOf(StringBuilder())
        val titles = mutableListOf<String>()

        /** 深度优先遍历 [node] 的子节点。 */
        fun collect(node: Node) {
            for (child in node.childNodes()) {
                if (child is TextNode) {
                    parts.last().append(child.wholeText)
                } else if (child is Element) {
                    collectElement(child)
                }
            }
        }

        private fun collectElement(element: Element) {
            val name = element.normalName()
            when {
                splitOnHeadings && (name == "h1" || name == "h2") -> {
                    titles.add(element.text())
                    parts.add(StringBuilder())
                }
                name == "br" -> parts.last().append("\n\n")
                else -> {
                    collect(element)
                    if (name in BLOCK_TAGS) parts.last().append("\n\n")
                }
            }
        }
    }
}
