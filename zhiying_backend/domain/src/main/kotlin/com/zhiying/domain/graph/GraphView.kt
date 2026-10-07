// 图谱视图：一次出图查询的完整结果（节点、边、标签、分区、过滤原因、分析范围），由 GraphProjection 纯函数生成。
package com.zhiying.domain.graph

import com.zhiying.domain.affiliations.GroupId
import com.zhiying.domain.identity.Gender
import com.zhiying.domain.identity.Importance
import com.zhiying.domain.identity.PersonId
import com.zhiying.domain.library.BookId
import com.zhiying.domain.library.ChapterId
import com.zhiying.domain.library.EvidenceRef
import com.zhiying.domain.relations.Hardness
import com.zhiying.domain.relations.OccurrenceId
import com.zhiying.domain.relations.RelationKey
import com.zhiying.domain.relations.RelationType
import com.zhiying.domain.revision.RevisionId

/**
 * 一种关系在图上的标签：同一规范键下全部准入记录汇总后的展示单元。
 *
 * 入参：[key] 关系键；[type] 类型定义；[chapters] 出现章节（按阅读顺序）；[evidence] 全部依据；
 * [occurrences] 汇入的记录 ID；[score] 展示分，只用于排序与默认过滤，不决定关系是否成立。
 */
data class RelationLabel(
    val key: RelationKey,
    val type: RelationType,
    val chapters: List<ChapterId>,
    val evidence: List<EvidenceRef>,
    val occurrences: List<OccurrenceId>,
    val score: Double,
) {
    /** 关系起点；有向关系时承担类型的源角色。 */
    val from: PersonId get() = key.first

    /** 关系终点。 */
    val to: PersonId get() = key.second

    /** 硬度。 */
    val hardness: Hardness get() = type.hardness

    /** 是否有带原文片段的合格证据。 */
    val hasQuotedEvidence: Boolean get() = evidence.any { it.quoted }
}

/**
 * 一条边：同一有序人物对上的全部标签。
 *
 * [labels] 默认可见的标签，按展示分降序；[folded] 被折叠进"更多"的软标签（该人物对已有硬 / 中关系），
 * 仍是已准入的事实，只是默认不展开。未决、否定的记录绝不会出现在这里。
 */
data class GraphEdge(
    val first: PersonId,
    val second: PersonId,
    val labels: List<RelationLabel>,
    val folded: List<RelationLabel>,
)

/**
 * 图上的人物节点。[groups] 为显式团体归属；[partition] 为落块用的分区 ID；[placementInferred] 表示落块是算法推断；
 * [chapters] 为出场章节的阅读序号（升序，章节聚焦时只含范围内的章）。
 */
data class GraphNode(
    val person: PersonId,
    val name: String,
    val aliases: List<String>,
    val gender: Gender,
    val importance: Importance?,
    val bio: String,
    val appearanceCount: Int,
    val groups: List<GroupId>,
    val partition: String?,
    val placementInferred: Boolean,
    val chapters: List<Int> = emptyList(),
)

/** 被过滤的原因。 */
enum class HideReason {
    /** 出场章数低于阈值，且无硬关系、不是聚焦人物。 */
    BELOW_MIN_APPEARANCE,
}

/** 一个被隐藏的人物及原因。 */
data class HiddenPerson(
    val person: PersonId,
    val name: String,
    val appearanceCount: Int,
    val reason: HideReason,
)

/** 过滤报告：本次使用的阈值、聚焦人物与被隐藏的人物名单（数量即名单长度）。 */
data class FilterReport(
    val minAppearance: Int,
    val focus: PersonId?,
    val hidden: List<HiddenPerson>,
) {
    /** 被隐藏的人物数量。 */
    val hiddenCount: Int get() = hidden.size
}

/** 未进入图的关系记录数量：仅计数，内容不出现在图中。 */
data class WithheldCounts(val undetermined: Int, val refuted: Int)

/** 分析范围：本结果版本覆盖的章节及其阅读序号。 */
data class AnalysisScope(val chapters: List<ChapterId>, val numbers: Map<ChapterId, Int>) {
    /** 章节的阅读序号（从 1 起）。 */
    fun numberOf(chapter: ChapterId): Int = numbers.getValue(chapter)
}

/** 分区方式。 */
enum class PartitionMode {
    /** 来自显式团体事实（含推断落块的人与"未归属"块）。 */
    GROUPS,

    /** 没有团体，按章节共现推断的"第 N 阶段"。 */
    INFERRED_STAGES,

    /** 无法分区：不含任何分区块，调用方应降级为强过滤子集并提示用户。 */
    DEGRADED,
}

/**
 * 一个分区块。[partition] 的成员是主归属落在本块的人物；[allMembers] 含次要归属；
 * [needsReview] 是块内与同伴都没有连线的人物。[kind] 为展示用类别（团体 "other"、阶段 "stage"）。
 */
data class PartitionBlock(
    val id: String,
    val name: String,
    val kind: String,
    val order: Int,
    val partition: LayoutPartition,
    val allMembers: Set<PersonId>,
    val needsReview: Set<PersonId>,
)

/** 人物落块结果。[inferred] 为 true 表示不是显式团体成员，而是邻居传播或阶段推断。 */
data class Placement(val blockId: String, val inferred: Boolean)

/** 当前图的分区方案；[degradedReason] 仅在 [PartitionMode.DEGRADED] 时说明降级原因。 */
data class PartitionPlan(
    val mode: PartitionMode,
    val blocks: List<PartitionBlock>,
    val placements: Map<PersonId, Placement>,
    val degradedReason: String? = null,
)

/**
 * 出图查询的完整结果：只读已发布结果版本得到的派生视图，导出 JSON 与页面共用同一份。
 */
data class GraphView(
    val bookId: BookId,
    val revision: RevisionId?,
    val scope: AnalysisScope,
    val nodes: List<GraphNode>,
    val edges: List<GraphEdge>,
    val partitions: PartitionPlan,
    val filter: FilterReport,
    val withheld: WithheldCounts,
    val chapterFocus: ChapterFocus? = null,
) {
    companion object {
        /** 空图：该书尚无已发布的结果版本时使用，[revision] 为空。 */
        fun empty(bookId: BookId, minAppearance: Int, focus: PersonId?) = GraphView(
            bookId = bookId,
            revision = null,
            scope = AnalysisScope(emptyList(), emptyMap()),
            nodes = emptyList(),
            edges = emptyList(),
            partitions = PartitionPlan(PartitionMode.DEGRADED, emptyList(), emptyMap(), "尚无已发布的分析结果"),
            filter = FilterReport(minAppearance, focus, emptyList()),
            withheld = WithheldCounts(0, 0),
        )
    }
}
