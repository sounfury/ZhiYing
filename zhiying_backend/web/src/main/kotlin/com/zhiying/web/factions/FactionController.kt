// 团体接口：GET /factions 返回当前已发布结果中的团体事实与成员（旧后端称势力）；布局推断的分区在图接口里，不在这里。
package com.zhiying.web.factions

import com.fasterxml.jackson.annotation.JsonProperty
import com.zhiying.application.bookquery.AffiliationView
import com.zhiying.application.bookquery.GetAffiliations
import com.zhiying.application.bookquery.GroupEntry
import com.zhiying.domain.library.BookId
import com.zhiying.domain.library.ChapterId
import com.zhiying.web.graph.EvidenceResponse
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController

/** 团体 HTTP 接口。 */
@RestController
@RequestMapping("/api/books/{bookId}/factions")
class FactionController(private val getAffiliations: GetAffiliations) {

    /** 团体列表与成员；书不存在返回 404，尚无已发布结果时返回空列表（revision_id 为 null）。 */
    @GetMapping
    fun factions(@PathVariable bookId: String): FactionsResponse =
        FactionsResponse.from(getAffiliations.execute(BookId(bookId)))
}

/** 团体成员：[chapterIds] 为归属依据所在章的阅读序号。 */
data class FactionMemberResponse(
    @JsonProperty("person_id") val personId: String,
    val name: String,
    val role: String,
    @JsonProperty("chapter_ids") val chapterIds: List<Int>,
    val evidence: EvidenceResponse,
)

/** 一个团体。[note] 为团体名称的来源说明；团体事实全部来自全书归纳，[inferred] 恒为 false。 */
data class FactionDetailResponse(
    @JsonProperty("faction_id") val factionId: String,
    val name: String,
    @JsonProperty("canonical_name") val canonicalName: String,
    val note: String,
    val inferred: Boolean,
    val members: List<FactionMemberResponse>,
) {
    companion object {
        /** 由团体条目转换；章节 ID 转成阅读序号。 */
        internal fun from(g: GroupEntry, number: (ChapterId) -> Int) = FactionDetailResponse(
            g.group.id.value, g.group.name, g.group.name, g.group.nameSource.note, false,
            g.members.map {
                FactionMemberResponse(
                    it.person.id.value, it.person.displayName, it.role.orEmpty(),
                    listOf(number(it.evidence.chapterId)), EvidenceResponse.from(it.evidence, number),
                )
            },
        )
    }
}

/** GET /api/books/{id}/factions 的响应体。 */
data class FactionsResponse(
    @JsonProperty("book_id") val bookId: String,
    @JsonProperty("revision_id") val revisionId: String?,
    val factions: List<FactionDetailResponse>,
) {
    companion object {
        /** 由团体视图转换。 */
        fun from(v: AffiliationView): FactionsResponse {
            val number: (ChapterId) -> Int = { v.numbers.getValue(it) }
            return FactionsResponse(v.bookId.value, v.revision?.value, v.groups.map { FactionDetailResponse.from(it, number) })
        }
    }
}
