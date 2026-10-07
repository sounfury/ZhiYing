// 图谱接口的 HTTP 表示：字段名沿用前端现有的 snake_case 约定，并附加新结果模型多出的信息（折叠标签、分区方式等）。
package com.zhiying.web.graph

import com.fasterxml.jackson.annotation.JsonProperty
import com.zhiying.application.graphquery.GraphResult
import com.zhiying.domain.graph.ChapterFocus
import com.zhiying.domain.graph.GraphEdge
import com.zhiying.domain.graph.GraphNode
import com.zhiying.domain.graph.PartitionBlock
import com.zhiying.domain.graph.PartitionMode
import com.zhiying.domain.graph.RelationLabel
import com.zhiying.domain.identity.Importance
import com.zhiying.domain.library.ChapterId
import com.zhiying.domain.library.EvidenceRef
import com.zhiying.domain.relations.Direction
import com.zhiying.domain.relations.Hardness

/** 章节 ID 到阅读序号的转换函数。 */
private typealias ChapterNumber = (ChapterId) -> Int

/**
 * 一条证据。[quote] 为兼容前端而填入证据说明（后端不持有正文，无法还原原文片段）；
 * [spans] 为带原文区间的片段位置，需要原文时由调用方按区间读取。
 */
data class EvidenceResponse(
    @JsonProperty("chapter_id") val chapterId: Int,
    val quote: String,
    val note: String,
    val spans: List<SpanResponse>,
) {
    companion object {
        /** 由证据转换；[number] 把章节 ID 转为阅读序号。 */
        internal fun from(e: EvidenceRef, number: ChapterNumber) =
            EvidenceResponse(number(e.chapterId), e.note, e.note, e.quotes.map { SpanResponse(it.start, it.end) })
    }
}

/** 原文区间（UTF-16 代码单元，半开）。 */
data class SpanResponse(val start: Int, val end: Int)

/** 边上的一个关系标签。 */
data class TagResponse(
    val key: String,
    val predicate: String,
    val label: String,
    val category: String,
    val hardness: String,
    val definition: String,
    val directed: Boolean,
    @JsonProperty("subject_role") val subjectRole: String,
    @JsonProperty("object_role") val objectRole: String,
    @JsonProperty("normalization_status") val normalizationStatus: String,
    @JsonProperty("relation_ids") val relationIds: List<String>,
    @JsonProperty("raw_relations") val rawRelations: List<String>,
    @JsonProperty("chapter_ids") val chapterIds: List<Int>,
    val evidences: List<EvidenceResponse>,
    @JsonProperty("display_score") val displayScore: Double,
    @JsonProperty("source_person_id") val sourcePersonId: String,
    @JsonProperty("target_person_id") val targetPersonId: String,
    @JsonProperty("in_focus_chapter") val inFocusChapter: Boolean,
) {
    companion object {
        /** 由标签转换；[focus] 非空且标签的章节含聚焦章时 in_focus_chapter 为 true。 */
        internal fun from(l: RelationLabel, number: ChapterNumber, focus: ChapterFocus?): TagResponse {
            val directed = l.type.direction as? Direction.Directed
            val chapterIds = l.chapters.map(number)
            return TagResponse(
                key = l.key.type.value,
                predicate = l.key.type.value,
                label = l.type.name,
                category = categoryOf(l.hardness),
                hardness = l.hardness.name.lowercase(),
                definition = l.type.definition,
                directed = directed != null,
                subjectRole = directed?.sourceRole ?: l.type.name,
                objectRole = directed?.targetRole ?: l.type.name,
                normalizationStatus = "resolved",
                relationIds = l.occurrences.map { it.value },
                rawRelations = l.evidence.map { it.note }.distinct(),
                chapterIds = chapterIds,
                evidences = l.evidence.map { EvidenceResponse.from(it, number) },
                displayScore = l.score,
                sourcePersonId = l.from.value,
                targetPersonId = l.to.value,
                inFocusChapter = focus != null && focus.number in chapterIds,
            )
        }
    }
}

/** 硬度的中文分类名，兼容前端按 category 分组与筛选。 */
internal fun categoryOf(h: Hardness): String = when (h) {
    Hardness.HARD -> "硬关系"
    Hardness.MEDIUM -> "中关系"
    Hardness.SOFT -> "软关系"
}

/** 重要度的前端取值：main / supporting / minor（未标注按 minor）。 */
internal fun importanceOf(i: Importance?): String = when (i) {
    Importance.PROTAGONIST -> "main"
    Importance.SUPPORTING -> "supporting"
    else -> "minor"
}

/** 一条边：[tags] 默认可见标签，[moreTags] 被折叠进更多的软标签。 */
data class EdgeResponse(
    @JsonProperty("person_a") val personA: String,
    @JsonProperty("person_b") val personB: String,
    val tags: List<TagResponse>,
    @JsonProperty("more_tags") val moreTags: List<TagResponse>,
) {
    companion object {
        /** 由边转换。 */
        internal fun from(e: GraphEdge, number: ChapterNumber, focus: ChapterFocus?) = EdgeResponse(
            e.first.value, e.second.value,
            e.labels.map { TagResponse.from(it, number, focus) }, e.folded.map { TagResponse.from(it, number, focus) },
        )
    }
}

/** 人物节点。 */
data class NodeResponse(
    @JsonProperty("person_id") val personId: String,
    val name: String,
    val aliases: List<String>,
    val gender: String,
    val importance: String,
    @JsonProperty("appearance_count") val appearanceCount: Int,
    val bio: String,
    @JsonProperty("faction_ids") val factionIds: List<String>,
    @JsonProperty("primary_faction_id") val primaryFactionId: String?,
    @JsonProperty("faction_inferred") val factionInferred: Boolean,
    @JsonProperty("chapter_ids") val chapterIds: List<Int>,
) {
    companion object {
        /** 由节点转换；重要度按前端约定映射为 main / supporting / minor，出场章节为阅读序号。 */
        fun from(n: GraphNode) = NodeResponse(
            n.person.value, n.name, n.aliases, n.gender.name.lowercase(), importanceOf(n.importance),
            n.appearanceCount, n.bio, n.groups.map { it.value }, n.partition, n.placementInferred,
            n.chapters,
        )
    }
}

/** 势力分区块。[basis] 为 group（来自团体事实）或 inferred（算法推断）。 */
data class FactionResponse(
    @JsonProperty("faction_id") val factionId: String,
    val name: String,
    val kind: String,
    val order: Int,
    @JsonProperty("member_ids") val memberIds: List<String>,
    @JsonProperty("all_member_ids") val allMemberIds: List<String>,
    val inferred: Boolean,
    val basis: String,
    @JsonProperty("needs_review") val needsReview: List<String>,
) {
    companion object {
        /** 由分区块转换；成员按 ID 排序以保证输出稳定。 */
        fun from(b: PartitionBlock) = FactionResponse(
            b.id, b.name, b.kind, b.order,
            b.partition.members.map { it.value }.sorted(), b.allMembers.map { it.value }.sorted(),
            b.partition.inferred, if (b.partition.inferred) "inferred" else "group",
            b.needsReview.map { it.value }.sorted(),
        )
    }
}

/** 被隐藏的路人。 */
data class FilteredPersonResponse(
    @JsonProperty("person_id") val personId: String,
    val name: String,
    @JsonProperty("appearance_count") val appearanceCount: Int,
    val reason: String,
)

/** 章节聚焦回显：chapter 为阅读序号，mode 为 single / upto。 */
data class ChapterFocusResponse(val chapter: Int, val mode: String)

/** GET /api/books/{id}/graph 的响应体。 */
data class GraphResponse(
    @JsonProperty("book_id") val bookId: String,
    @JsonProperty("revision_id") val revisionId: String?,
    @JsonProperty("chapter_range") val chapterRange: List<Int>,
    @JsonProperty("total_chapters") val totalChapters: Int,
    val nodes: List<NodeResponse>,
    val edges: List<EdgeResponse>,
    val factions: List<FactionResponse>,
    @JsonProperty("partition_mode") val partitionMode: String,
    @JsonProperty("partition_degraded_reason") val partitionDegradedReason: String?,
    @JsonProperty("min_appearance") val minAppearance: Int,
    @JsonProperty("focus_person_id") val focusPersonId: String?,
    @JsonProperty("filtered_count") val filteredCount: Int,
    @JsonProperty("filtered_persons") val filteredPersons: List<FilteredPersonResponse>,
    @JsonProperty("pending_relation_count") val pendingRelationCount: Int,
    @JsonProperty("rejected_relation_count") val rejectedRelationCount: Int,
    @JsonProperty("unclassified_relation_count") val unclassifiedRelationCount: Int,
    @JsonProperty("chapter_focus") val chapterFocus: ChapterFocusResponse?,
) {
    companion object {
        /** 由出图结果转换；章节 ID 统一转成阅读序号，total_chapters 取书籍总章数。 */
        fun from(result: GraphResult): GraphResponse {
            val v = result.view
            val number: ChapterNumber = v.scope::numberOf
            val numbers = v.scope.numbers.values
            return GraphResponse(
                bookId = v.bookId.value,
                revisionId = v.revision?.value,
                chapterRange = if (numbers.isEmpty()) emptyList() else listOf(numbers.min(), numbers.max()),
                totalChapters = result.totalChapters,
                nodes = v.nodes.map(NodeResponse::from),
                edges = v.edges.map { EdgeResponse.from(it, number, v.chapterFocus) },
                factions = v.partitions.blocks.map(FactionResponse::from),
                partitionMode = when (v.partitions.mode) {
                    PartitionMode.GROUPS -> "groups"
                    PartitionMode.INFERRED_STAGES -> "inferred_stages"
                    PartitionMode.DEGRADED -> "degraded"
                },
                partitionDegradedReason = v.partitions.degradedReason,
                minAppearance = v.filter.minAppearance,
                focusPersonId = v.filter.focus?.value,
                filteredCount = v.filter.hiddenCount,
                filteredPersons = v.filter.hidden.map {
                    FilteredPersonResponse(it.person.value, it.name, it.appearanceCount, it.reason.name.lowercase())
                },
                pendingRelationCount = v.withheld.undetermined,
                rejectedRelationCount = v.withheld.refuted,
                unclassifiedRelationCount = 0,
                chapterFocus = v.chapterFocus?.let { ChapterFocusResponse(it.number, it.mode.name.lowercase()) },
            )
        }
    }
}

/** GET /api/books/{id}/export 的响应体：格式标识 + 与页面相同的图数据。 */
data class ExportResponse(
    val format: String,
    val version: Int,
    @JsonProperty("exported_at") val exportedAt: String,
    val graph: GraphResponse,
)
