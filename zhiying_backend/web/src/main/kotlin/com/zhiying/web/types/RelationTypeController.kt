// 关系类型接口：GET /relation-types 返回本书类型库（内置 + 书内新增）及使用次数；字段名沿用旧后端的 snake_case 约定。
package com.zhiying.web.types

import com.fasterxml.jackson.annotation.JsonProperty
import com.zhiying.application.bookquery.GetRelationTypes
import com.zhiying.application.bookquery.RelationTypeUsage
import com.zhiying.application.bookquery.RelationTypeView
import com.zhiying.domain.library.BookId
import com.zhiying.domain.relations.Direction
import com.zhiying.domain.relations.TypeOrigin
import com.zhiying.web.graph.categoryOf
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController

/** 关系类型 HTTP 接口。 */
@RestController
@RequestMapping("/api/books/{bookId}/relation-types")
class RelationTypeController(private val getRelationTypes: GetRelationTypes) {

    /** 本书类型库；书不存在返回 404，尚无已发布结果时返回内置类型（使用次数为 0，revision_id 为 null）。 */
    @GetMapping
    fun relationTypes(@PathVariable bookId: String): RelationTypesResponse =
        RelationTypesResponse.from(getRelationTypes.execute(BookId(bookId)))
}

/**
 * 一种关系类型。[predicate] 是类型 ID，[label] 是正式名，[category] 是硬度的中文分类；
 * [source] 为 seed（内置）或 learned（本书新增）；[factCount]、[occurrenceCount] 为当前结果中的使用次数。
 */
data class RelationTypeResponse(
    val predicate: String,
    val label: String,
    val category: String,
    val hardness: String,
    val definition: String,
    val directed: Boolean,
    @JsonProperty("subject_role") val subjectRole: String,
    @JsonProperty("object_role") val objectRole: String,
    val aliases: List<String>,
    @JsonProperty("reverse_names") val reverseNames: List<String>,
    val source: String,
    @JsonProperty("fact_count") val factCount: Int,
    @JsonProperty("occurrence_count") val occurrenceCount: Int,
) {
    companion object {
        /** 由类型及使用情况转换；无向类型两端角色都取类型名。 */
        internal fun from(u: RelationTypeUsage): RelationTypeResponse {
            val t = u.type
            val directed = t.direction as? Direction.Directed
            return RelationTypeResponse(
                t.id.value, t.name, categoryOf(t.hardness), t.hardness.name.lowercase(), t.definition, directed != null,
                directed?.sourceRole ?: t.name, directed?.targetRole ?: t.name,
                t.synonyms.sorted(), t.reverseNames.sorted(),
                if (t.origin == TypeOrigin.BUILT_IN) "seed" else "learned",
                u.factCount, u.occurrenceCount,
            )
        }
    }
}

/** GET /api/books/{id}/relation-types 的响应体。 */
data class RelationTypesResponse(
    @JsonProperty("book_id") val bookId: String,
    @JsonProperty("revision_id") val revisionId: String?,
    @JsonProperty("relation_types") val relationTypes: List<RelationTypeResponse>,
) {
    companion object {
        /** 由类型库视图转换。 */
        fun from(v: RelationTypeView) =
            RelationTypesResponse(v.bookId.value, v.revision?.value, v.types.map(RelationTypeResponse::from))
    }
}
