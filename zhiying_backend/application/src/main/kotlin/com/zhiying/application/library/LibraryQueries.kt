// 书库查询用例：列书、取书、列章节、读章节正文；章节阅读等后续模块通过本类读取正文。
package com.zhiying.application.library

import com.zhiying.application.error.AppException
import com.zhiying.application.error.ErrorCode
import com.zhiying.domain.library.BookId
import com.zhiying.domain.library.Chapter
import com.zhiying.domain.library.ChapterId
import com.zhiying.domain.library.ChapterOutline
import org.springframework.stereotype.Service

/** 书库查询服务；只读，找不到资源统一抛 [ErrorCode.NOT_FOUND]。 */
@Service
class LibraryQueries(private val books: BookRepository) {

    /** 列出全部书（新导入的在前）。 */
    fun listBooks(): List<BookOverview> = books.listBooks()

    /** 取书概览；书不存在抛 NOT_FOUND。 */
    fun getBook(id: BookId): BookOverview = books.findBook(id) ?: notFound("书不存在：${id.value}")

    /** 按阅读顺序列出章节概要（含不参与分析的章节及原因）；书不存在抛 NOT_FOUND。 */
    fun listChapters(id: BookId): List<ChapterOutline> {
        getBook(id)
        return books.listChapters(id)
    }

    /** 读取某本书第 [order] 章（从 1 开始）的正文；不存在抛 NOT_FOUND。 */
    fun readChapter(id: BookId, order: Int): Chapter =
        books.findChapter(id, order) ?: notFound("章节不存在：${id.value} 第 $order 章")

    /** 按章节 ID 读取正文；不存在抛 NOT_FOUND。 */
    fun readChapter(id: ChapterId): Chapter = books.findChapter(id) ?: notFound("章节不存在：${id.value}")

    /** 列出参与分析的章节概要，供分析模块确定默认范围。 */
    fun listAnalyzableChapters(id: BookId): List<ChapterOutline> = listChapters(id).filter { it.inclusion.included }

    private fun notFound(message: String): Nothing = throw AppException(ErrorCode.NOT_FOUND, message)
}
