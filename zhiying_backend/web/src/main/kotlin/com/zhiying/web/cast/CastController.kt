// 人物接口：GET /cast 人名册（可按出场数排序）、GET /cast/{personId} 人物详情；字段名沿用旧后端的 snake_case 约定。
package com.zhiying.web.cast

import com.fasterxml.jackson.annotation.JsonProperty
import com.zhiying.application.bookquery.CastEntry
import com.zhiying.application.bookquery.CastOrder
import com.zhiying.application.bookquery.CastView
import com.zhiying.application.bookquery.GetCast
import com.zhiying.application.bookquery.GetPersonDetail
import com.zhiying.application.bookquery.PersonDetail
import com.zhiying.application.error.AppException
import com.zhiying.application.error.ErrorCode
import com.zhiying.domain.identity.PersonId
import com.zhiying.domain.library.BookId
import com.zhiying.domain.library.ChapterId
import com.zhiying.web.graph.EvidenceResponse
import com.zhiying.web.graph.categoryOf
import com.zhiying.web.graph.importanceOf
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController

/** 人物 HTTP 接口。 */
@RestController
@RequestMapping("/api/books/{bookId}/cast")
class CastController(private val getCast: GetCast, private val getPersonDetail: GetPersonDetail) {

    /**
     * 人名册。参数 sort：default（人物建立顺序，缺省）或 appearance（按出场章数降序）。
     * 书不存在返回 404；尚无已发布结果时返回空名册（200，revision_id 为 null）。
     */
    @GetMapping
    fun cast(@PathVariable bookId: String, @RequestParam("sort", required = false) sort: String?): CastResponse =
        CastResponse.from(getCast.execute(BookId(bookId), orderOf(sort)))

    /** 人物详情：基本信息、团体归属与全部关系事实；人物不存在返回 404。 */
    @GetMapping("/{personId}")
    fun detail(@PathVariable bookId: String, @PathVariable personId: String): PersonDetailResponse =
        PersonDetailResponse.from(getPersonDetail.execute(BookId(bookId), PersonId(personId)))

    /** 排序参数；不认识的取值返回 INVALID_ARGUMENT。 */
    private fun orderOf(raw: String?): CastOrder = when (raw?.trim()?.lowercase()) {
        null, "", "default" -> CastOrder.DEFAULT
        "appearance" -> CastOrder.APPEARANCE
        else -> throw AppException(ErrorCode.INVALID_ARGUMENT, "sort 只能是 default、appearance: $raw")
    }
}

/** 人物所属团体的简要引用。 */
data class FactionRefResponse(@JsonProperty("faction_id") val factionId: String, val name: String)

/** 人名册中的一个人物。[canonicalName] 与 [name] 同值，前者兼容旧前端。 */
data class CastPersonResponse(
    @JsonProperty("person_id") val personId: String,
    @JsonProperty("canonical_name") val canonicalName: String,
    val name: String,
    val aliases: List<String>,
    val bio: String,
    val gender: String,
    val importance: String,
    @JsonProperty("appearance_count") val appearanceCount: Int,
    val factions: List<FactionRefResponse>,
) {
    companion object {
        /** 由名册条目转换。 */
        internal fun from(e: CastEntry): CastPersonResponse = e.person.let { p ->
            CastPersonResponse(
                p.id.value, p.displayName, p.displayName, p.aliases, p.profile.orEmpty(), p.gender.name.lowercase(),
                importanceOf(p.importance), e.appearanceCount, e.groups.map { FactionRefResponse(it.id.value, it.name) },
            )
        }
    }
}

/** GET /api/books/{id}/cast 的响应体。 */
data class CastResponse(
    @JsonProperty("book_id") val bookId: String,
    @JsonProperty("revision_id") val revisionId: String?,
    val persons: List<CastPersonResponse>,
) {
    companion object {
        /** 由名册转换。 */
        fun from(v: CastView) = CastResponse(v.bookId.value, v.revision?.value, v.persons.map(CastPersonResponse::from))
    }
}

/** 人物在某团体中的归属。 */
data class PersonFactionResponse(
    @JsonProperty("faction_id") val factionId: String,
    val name: String,
    val role: String,
    val evidence: EvidenceResponse,
)

/**
 * 人物的一条关系事实。[directed] 为真时 [selfRole]、[otherRole] 是两端角色，[outgoing] 表示本人是源端；
 * 无向关系两端角色都取类型名，[outgoing] 为 null。
 */
data class PersonRelationResponse(
    @JsonProperty("other_person_id") val otherPersonId: String,
    @JsonProperty("other_name") val otherName: String,
    val predicate: String,
    val label: String,
    val category: String,
    val hardness: String,
    val directed: Boolean,
    val outgoing: Boolean?,
    @JsonProperty("self_role") val selfRole: String,
    @JsonProperty("other_role") val otherRole: String,
    @JsonProperty("chapter_ids") val chapterIds: List<Int>,
    val evidences: List<EvidenceResponse>,
)

/** GET /api/books/{id}/cast/{personId} 的响应体。 */
data class PersonDetailResponse(
    @JsonProperty("book_id") val bookId: String,
    @JsonProperty("revision_id") val revisionId: String,
    val person: CastPersonResponse,
    val factions: List<PersonFactionResponse>,
    val relations: List<PersonRelationResponse>,
) {
    companion object {
        /** 由人物详情转换；章节 ID 统一转成阅读序号。 */
        fun from(d: PersonDetail): PersonDetailResponse {
            val number: (ChapterId) -> Int = { d.numbers.getValue(it) }
            return PersonDetailResponse(
                d.bookId.value, d.revision.value, CastPersonResponse.from(d.entry),
                d.memberships.map {
                    PersonFactionResponse(it.group.id.value, it.group.name, it.role.orEmpty(), EvidenceResponse.from(it.evidence, number))
                },
                d.relations.map { r ->
                    PersonRelationResponse(
                        r.other.id.value, r.other.displayName, r.type.id.value, r.type.name, categoryOf(r.type.hardness),
                        r.type.hardness.name.lowercase(), r.selfRole != null, r.outgoing,
                        r.selfRole ?: r.type.name, r.otherRole ?: r.type.name,
                        r.chapters.map(number), r.evidence.map { EvidenceResponse.from(it, number) },
                    )
                },
            )
        }
    }
}
