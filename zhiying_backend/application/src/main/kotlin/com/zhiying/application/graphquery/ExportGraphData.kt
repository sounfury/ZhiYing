// 导出用例：导出与页面同一份图数据（JSON 由 web 层序列化）。
package com.zhiying.application.graphquery

import com.zhiying.domain.library.BookId
import org.springframework.stereotype.Service
import java.time.Instant

/** 导出结果：同一份出图结果加导出时间。 */
data class GraphExport(val graph: GraphResult, val exportedAt: Instant)

/**
 * 导出图数据。直接复用 [GetGraph]，因此导出内容与页面在相同参数下完全一致，不另建第二套聚合。
 */
@Service
class ExportGraphData(private val getGraph: GetGraph) {

    /** 入参：[bookId] 书 ID；[request] 与出图相同的过滤条件。出参：[GraphExport]。 */
    fun execute(bookId: BookId, request: GraphRequest = GraphRequest()): GraphExport =
        GraphExport(getGraph.execute(bookId, request), Instant.now())
}
