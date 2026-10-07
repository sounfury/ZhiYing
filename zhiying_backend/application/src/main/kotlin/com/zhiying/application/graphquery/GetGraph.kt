// 出图用例：读取一本书当前已发布的结果版本，调用领域投影得到图谱视图。
package com.zhiying.application.graphquery

import com.zhiying.application.error.AppException
import com.zhiying.application.error.ErrorCode
import com.zhiying.application.library.LibraryQueries
import com.zhiying.domain.graph.ChapterFocus
import com.zhiying.domain.graph.DisplayScoring
import com.zhiying.domain.graph.GraphProjection
import com.zhiying.domain.graph.GraphQuery
import com.zhiying.domain.graph.GraphView
import com.zhiying.domain.identity.PersonId
import com.zhiying.domain.library.BookId
import com.zhiying.domain.relations.Hardness
import com.zhiying.domain.relations.RelationTypeId
import org.springframework.stereotype.Service

/** 出图可调参数（由配置装配）：展示分系数与路人过滤的默认阈值。 */
data class GraphSettings(
    val scoring: DisplayScoring = DisplayScoring(),
    val defaultMinAppearance: Int = GraphQuery.DEFAULT_MIN_APPEARANCE,
)

/**
 * 一次出图请求。[minAppearance] 为空时用默认阈值；[focus] 为聚焦人物 ID；
 * [types] 为只看的关系类型 ID；[hardness] 为只看的硬度，二者为空表示不限；[chapterFocus] 为章节聚焦，空表示全书。
 */
data class GraphRequest(
    val minAppearance: Int? = null,
    val focus: PersonId? = null,
    val types: Set<RelationTypeId> = emptySet(),
    val hardness: Set<Hardness> = emptySet(),
    val chapterFocus: ChapterFocus? = null,
)

/** 出图结果：图视图加书籍总章数（含不参与分析的章节，与分析范围内的章数不同）。 */
data class GraphResult(val view: GraphView, val totalChapters: Int)

/**
 * 查询某本书的关系图。
 *
 * 副作用：读书库确认书存在并取总章数，再只读一次结果存储（固定读取当前已发布的一个版本）。书不存在抛 NOT_FOUND。尚无已发布版本时返回空图而不是错误，
 * 这样刚导入、未分析的书可以直接渲染"暂无数据"。
 */
@Service
class GetGraph(
    private val store: RevisionStore,
    private val library: LibraryQueries,
    private val settings: GraphSettings,
) {

    /**
     * 执行查询。
     *
     * 入参：[bookId] 书 ID；[request] 过滤、聚焦、筛选条件。
     * 出参：[GraphResult]。阈值为负时抛出 INVALID_ARGUMENT；聚焦人物不在当前结果版本内时抛出 NOT_FOUND。
     */
    fun execute(bookId: BookId, request: GraphRequest = GraphRequest()): GraphResult {
        val min = request.minAppearance ?: settings.defaultMinAppearance
        if (min < 0) throw AppException(ErrorCode.INVALID_ARGUMENT, "min_appearance 不能为负")
        // 1. 读书库：书不存在直接 404，并取书籍总章数
        val totalChapters = library.getBook(bookId).profile.totalChapters
        // 2. 读取当前已发布版本（固定一个版本）
        val revision = store.findPublished(bookId)
            ?: return GraphResult(GraphView.empty(bookId, min, request.focus), totalChapters)
        if (request.focus != null && request.focus !in revision.personsById) {
            throw AppException(ErrorCode.NOT_FOUND, "人物不存在: ${request.focus!!.value}")
        }
        // 3. 纯计算投影
        val query = GraphQuery(min, request.focus, request.types, request.hardness, request.chapterFocus)
        return GraphResult(GraphProjection.project(revision, query, settings.scoring), totalChapters)
    }
}
