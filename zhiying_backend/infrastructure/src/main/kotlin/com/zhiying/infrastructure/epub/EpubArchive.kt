// EPUB 容器读取：解 zip，按 container.xml → OPF 找到 spine 阅读顺序、书元数据与目录（nav / NCX）标题。
package com.zhiying.infrastructure.epub

import com.zhiying.application.error.AppException
import com.zhiying.application.error.ErrorCode
import org.jsoup.Jsoup
import org.jsoup.nodes.Document
import org.jsoup.parser.Parser
import java.io.ByteArrayInputStream
import java.net.URLDecoder
import java.util.zip.ZipInputStream

/**
 * spine 中的一份文档。
 *
 * 入参：[href] 相对 OPF 所在目录的路径（与旧后端的 source_href 同义）；[content] 文件字节；[tocTitle] 目录里给它的标题，可为空。
 */
internal class SpineDocument(val href: String, val content: ByteArray, val tocTitle: String?)

/** 读出的 EPUB：书名、作者与按阅读顺序排列的文档。 */
internal class EpubContents(val title: String?, val author: String?, val documents: List<SpineDocument>)

/** EPUB 容器读取器。 */
internal object EpubArchive {

    /** 只读取解析需要的文本类条目，跳过图片、字体等大文件。 */
    private val TEXT_EXTENSIONS = setOf("xhtml", "html", "htm", "xml", "opf", "ncx")

    /** 可作为章节来源的文档类型（对应旧实现的 ITEM_DOCUMENT）。 */
    private val DOCUMENT_TYPES = setOf("application/xhtml+xml", "text/html")

    /** manifest 条目：[props] 为空格分隔的 properties 属性。 */
    private class ManifestItem(val href: String, val mediaType: String, val props: Set<String>)

    /**
     * 读取 EPUB。
     *
     * 入参：[bytes] 文件字节。出参：书元数据与 spine 文档。
     * 不是合法 zip / EPUB，或 spine 中没有文档时抛 UNREADABLE_BOOK。
     */
    fun read(bytes: ByteArray): EpubContents {
        val entries = unzip(bytes)
        val container = entries["META-INF/container.xml"] ?: unreadable("缺少 META-INF/container.xml，不是有效的 EPUB")
        val opfPath = xml(container).selectFirst("rootfile[full-path]")?.attr("full-path")?.trim().orEmpty()
        val opf = entries[opfPath]?.let(::xml) ?: unreadable("找不到 OPF 包文件：$opfPath")
        val opfDir = opfPath.substringBeforeLast('/', "")

        val manifest = opf.select("manifest > item").associate { item ->
            item.attr("id") to ManifestItem(
                resolve(opfDir, item.attr("href")),
                item.attr("media-type").lowercase(),
                item.attr("properties").split(' ').filter { it.isNotBlank() }.toSet(),
            )
        }
        val tocTitles = readTocTitles(manifest.values, entries)
        val documents = opf.select("spine > itemref").mapNotNull { ref ->
            val item = manifest[ref.attr("idref")]
            val content = item?.let { entries[it.href] }
            if (item == null || content == null || item.mediaType !in DOCUMENT_TYPES || "nav" in item.props) null
            else SpineDocument(item.href.removePrefix("$opfDir/"), content, tocTitles[item.href])
        }
        if (documents.isEmpty()) unreadable("EPUB spine 为空，无法提取内容")
        return EpubContents(metadata(opf, "dc:title"), metadata(opf, "dc:creator"), documents)
    }

    /** 取第一条 DC 元数据的文本；缺失或为空返回 null。 */
    private fun metadata(opf: Document, tag: String): String? =
        opf.getElementsByTag(tag).firstOrNull()?.text()?.trim()?.takeIf { it.isNotEmpty() }

    /**
     * 汇总目录标题：先读 EPUB3 nav 文档，再用 EPUB2 NCX 补充；同一文件取目录中最先出现的标题。
     * 出参：压缩包内完整路径 → 目录标题。
     */
    private fun readTocTitles(
        items: Collection<ManifestItem>,
        entries: Map<String, ByteArray>,
    ): Map<String, String> {
        val titles = LinkedHashMap<String, String>()
        fun add(baseDir: String, href: String, title: String) {
            val path = resolve(baseDir, href)
            if (title.isNotBlank() && href.isNotBlank()) titles.putIfAbsent(path, title.trim())
        }
        for (item in items.filter { "nav" in it.props }) {
            val doc = entries[item.href]?.let(::xml) ?: continue
            val navs = doc.select("nav")
            val toc = navs.firstOrNull { it.attr("epub:type") == "toc" } ?: navs.firstOrNull() ?: continue
            val dir = item.href.substringBeforeLast('/', "")
            toc.select("a[href]").forEach { add(dir, it.attr("href"), it.text()) }
        }
        for (item in items.filter { it.mediaType == "application/x-dtbncx+xml" }) {
            val doc = entries[item.href]?.let(::xml) ?: continue
            val dir = item.href.substringBeforeLast('/', "")
            doc.select("navPoint").forEach { point ->
                val label = point.getElementsByTag("navLabel").firstOrNull()?.text().orEmpty()
                add(dir, point.getElementsByTag("content").firstOrNull()?.attr("src").orEmpty(), label)
            }
        }
        return titles
    }

    /** 解压 zip，只保留文本类条目；不是 zip 时抛 UNREADABLE_BOOK。 */
    private fun unzip(bytes: ByteArray): Map<String, ByteArray> {
        val result = HashMap<String, ByteArray>()
        try {
            ZipInputStream(ByteArrayInputStream(bytes)).use { zip ->
                generateSequence { zip.nextEntry }.forEach { entry ->
                    if (!entry.isDirectory && entry.name.substringAfterLast('.').lowercase() in TEXT_EXTENSIONS) {
                        result[entry.name.removePrefix("/")] = zip.readBytes()
                    }
                }
            }
        } catch (e: java.io.IOException) {
            throw AppException(ErrorCode.UNREADABLE_BOOK, "无法读取 EPUB 文件：${e.message}", e)
        }
        if (result.isEmpty()) unreadable("无法读取 EPUB 文件：不是有效的 zip 压缩包")
        return result
    }

    /** 以 XML 方式解析（保留标签大小写与带前缀的属性）。 */
    private fun xml(content: ByteArray): Document = Jsoup.parse(ByteArrayInputStream(content), null, "", Parser.xmlParser())

    /**
     * 把 href 解析为压缩包内路径：去掉锚点、URL 解码、按 [baseDir] 展开 `./` 与 `../`。
     */
    private fun resolve(baseDir: String, href: String): String {
        val raw = href.substringBefore('#').replace("+", "%2B")
        val decoded = runCatching { URLDecoder.decode(raw, Charsets.UTF_8) }.getOrDefault(raw)
        val parts = ArrayList<String>()
        for (seg in "$baseDir/$decoded".split('/')) {
            when (seg) {
                "", "." -> Unit
                ".." -> if (parts.isNotEmpty()) parts.removeAt(parts.size - 1)
                else -> parts.add(seg)
            }
        }
        return parts.joinToString("/")
    }

    private fun unreadable(message: String): Nothing = throw AppException(ErrorCode.UNREADABLE_BOOK, message)
}
