// 章节阅读序号：把结果版本覆盖的章节映射为阅读序号，规则与图投影一致，供查询与团体归纳共用。
package com.zhiying.application.bookquery

import com.zhiying.domain.library.ChapterId
import com.zhiying.domain.revision.AnalysisRevision

/** 版本覆盖章节的阅读序号（从 1 起），按序号升序；版本未提供序号时按章节 ID 排序后编号。 */
internal fun AnalysisRevision.chapterNumbers(): Map<ChapterId, Int> {
    val sorted = analyzedChapters.sortedWith(compareBy({ chapterOrder[it] ?: Int.MAX_VALUE }, { it.value }))
    return sorted.withIndex().associate { (index, id) -> id to (chapterOrder[id] ?: (index + 1)) }
}
