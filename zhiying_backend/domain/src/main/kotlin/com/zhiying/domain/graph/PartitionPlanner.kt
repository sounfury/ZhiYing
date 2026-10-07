// 势力分区：为当前图决定每个人物落进哪个块。显式团体优先；没有团体时按章节共现推断"第 N 阶段"；
// 实在无法分区时降级并写明原因。算法移植自旧 faction_resolver.py（主势力选择、邻居传播、环形排序、孤立成员标记），
// 团体事实与布局推断分开表达：推断出的落块不会写回团体事实。
package com.zhiying.domain.graph

import com.zhiying.domain.affiliations.GroupId
import com.zhiying.domain.identity.PersonId
import com.zhiying.domain.revision.AnalysisRevision

/** 分区块草稿：[placed] 主归属落在本块的人物，[all] 含次要归属。 */
private data class BlockDraft(
    val id: String,
    val name: String,
    val kind: String,
    val basis: PartitionBasis,
    val placed: Set<PersonId>,
    val all: Set<PersonId>,
)

/** 邻接表：人物 → (邻居 → 边权重)，权重取该人物对上最高的标签展示分。 */
private typealias Links = Map<PersonId, Map<PersonId, Double>>

/** 分区规划入口，无状态、无副作用。 */
internal object PartitionPlanner {
    /** 未归属块的 ID，前端把它当作排在环尾的兜底块。 */
    const val UNASSIGNED_ID = "__unassigned"
    private const val UNASSIGNED_NAME = "未归属"

    /** 邻居传播轮数。 */
    private const val PROPAGATE_ROUNDS = 2

    /** 块内成员数达到此值才标记孤立成员（两人块没有连线是常态）。 */
    private const val REVIEW_MIN_SIZE = 3

    /** 阶段推断需要的最少人物数、每阶段最少章节数与阶段数上限。 */
    private const val STAGE_MIN_PEOPLE = 8
    private const val STAGE_MIN_CHAPTERS = 4
    private const val STAGE_MAX = 6

    /**
     * 规划分区。
     *
     * 入参：[revision] 结果版本；[scope] 分析范围（章节已按阅读顺序）；[nodes] 当前图上的人物；[edges] 当前图的边。
     * 出参：[PartitionPlan]。流程：有显式团体成员 → 按团体分区；否则按阶段推断；再不行降级。
     */
    fun plan(revision: AnalysisRevision, scope: AnalysisScope, nodes: Set<PersonId>, edges: List<GraphEdge>): PartitionPlan {
        val links = linksOf(edges)
        val hasGroupMember = revision.affiliations.memberships.any { it.person in nodes }
        return if (hasGroupMember) byGroups(revision, nodes, links) else byStages(revision, scope, nodes, links)
    }

    /** 由边建立邻接表。 */
    private fun linksOf(edges: List<GraphEdge>): Links {
        val weights = mutableMapOf<PersonId, MutableMap<PersonId, Double>>()
        for (edge in edges) {
            val weight = edge.labels.maxOfOrNull { it.score } ?: continue
            weights.getOrPut(edge.first) { mutableMapOf() }.merge(edge.second, weight, ::maxOf)
            weights.getOrPut(edge.second) { mutableMapOf() }.merge(edge.first, weight, ::maxOf)
        }
        return weights
    }

    /**
     * 显式团体分区。
     * 流程：每人在所属团体中选主归属（与块内成员连线最多者，并列取大块再取 ID）→ 无归属者按邻居多数票落块 →
     * 仍无归属者进入"未归属"块 → 块按跨块连线数环形排序。
     */
    private fun byGroups(revision: AnalysisRevision, nodes: Set<PersonId>, links: Links): PartitionPlan {
        val explicit = revision.affiliations.memberships.filter { it.person in nodes }
            .groupBy({ it.group }, { it.person }).mapValues { it.value.toSet() }
        val primary = pickPrimary(explicit, links)
        val inferred = propagate(primary, nodes, links)
        val names = revision.affiliations.groups.associate { it.id to it.name }
        val drafts = explicit.keys.sortedBy { it.value }.mapNotNull { group ->
            val placed = primary.filterValues { it == group.value }.keys
            if (placed.isEmpty()) null else BlockDraft(
                group.value, names.getValue(group), "other", PartitionBasis.Group(group),
                placed, explicit.getValue(group) + placed,
            )
        }
        val ordered = ringOrder(drafts, primary, links)
        val orphans = nodes.filter { it !in primary }.toSet()
        val tail = if (orphans.isEmpty()) emptyList() else listOf(unassigned(orphans))
        val placements = primary.mapValues { (person, block) -> Placement(block, person in inferred) } +
            orphans.associateWith { Placement(UNASSIGNED_ID, false) }
        return PartitionPlan(PartitionMode.GROUPS, finish(ordered + tail, links), placements)
    }

    /** 每个有显式归属的人选主团体：与块内成员连线越多越优先，并列取大块，再按 ID 稳定。 */
    private fun pickPrimary(explicit: Map<GroupId, Set<PersonId>>, links: Links): MutableMap<PersonId, String> {
        val groupsOf = mutableMapOf<PersonId, MutableList<GroupId>>()
        explicit.forEach { (group, members) -> members.forEach { groupsOf.getOrPut(it) { mutableListOf() } += group } }
        val primary = mutableMapOf<PersonId, String>()
        for ((person, groups) in groupsOf) {
            val neighbors = links[person].orEmpty().keys
            val best = groups.sortedWith(
                compareBy<GroupId>({ -explicit.getValue(it).count { m -> m in neighbors } }, { -explicit.getValue(it).size }, { it.value }),
            ).first()
            primary[person] = best.value
        }
        return primary
    }

    /**
     * 无归属者按邻居加权多数票落块（两轮，就地写入 [primary]），返回被推断落块的人物。
     * 只借已知块的归属向外扩一层，不做社区发现。
     */
    private fun propagate(primary: MutableMap<PersonId, String>, nodes: Set<PersonId>, links: Links): Set<PersonId> {
        val inferred = mutableSetOf<PersonId>()
        repeat(PROPAGATE_ROUNDS) {
            val round = nodes.filter { it !in primary }.sortedBy { it.value }.mapNotNull { person ->
                val votes = mutableMapOf<String, Double>()
                links[person].orEmpty().forEach { (neighbor, weight) ->
                    primary[neighbor]?.let { votes.merge(it, weight, Double::plus) }
                }
                votes.entries.sortedWith(compareBy({ -it.value }, { it.key })).firstOrNull()?.let { person to it.key }
            }
            primary += round
            inferred += round.map { it.first }
        }
        return inferred
    }

    /** "未归属"兜底块。 */
    private fun unassigned(members: Set<PersonId>) = BlockDraft(
        UNASSIGNED_ID, UNASSIGNED_NAME, "other", PartitionBasis.Inferred(UNASSIGNED_NAME), members, members,
    )

    /**
     * 贪心链排序：从最大块起，每次接上与队尾共享连线最多的未排块，使联系紧密的块相邻、跨块长边变短。
     */
    private fun ringOrder(drafts: List<BlockDraft>, primary: Map<PersonId, String>, links: Links): List<BlockDraft> {
        if (drafts.size <= 2) return drafts
        val cross = mutableMapOf<Pair<String, String>, Int>()
        for ((a, neighbors) in links) {
            for (b in neighbors.keys.filter { it.value > a.value }) {
                val (fa, fb) = (primary[a] ?: continue) to (primary[b] ?: continue)
                if (fa != fb) cross.merge(minOf(fa, fb) to maxOf(fa, fb), 1, Int::plus)
            }
        }
        fun link(a: String, b: String) = cross[minOf(a, b) to maxOf(a, b)] ?: 0
        val ids = drafts.map { it.id }
        val total = ids.associateWith { id -> ids.filter { it != id }.sumOf { link(id, it) } }
        val size = drafts.associate { it.id to it.placed.size }
        val chain = mutableListOf(ids.sorted().maxWith(compareBy({ size.getValue(it) }, { total.getValue(it) })))
        val remaining = ids.toMutableSet().apply { remove(chain.first()) }
        while (remaining.isNotEmpty()) {
            val tail = chain.last()
            val next = remaining.sorted().maxWith(
                compareBy({ link(tail, it) }, { total.getValue(it) }, { size.getValue(it) }),
            )
            chain += next
            remaining -= next
        }
        val byId = drafts.associateBy { it.id }
        return chain.map { byId.getValue(it) }
    }

    /**
     * 阶段推断分区：把已分析章节按阅读顺序等分成若干阶段，每个人归入自己出场章数最多的阶段，命名"第 N 阶段"。
     * 人物太少、章节太少或全部落在同一阶段时降级，不硬造分区。
     */
    private fun byStages(revision: AnalysisRevision, scope: AnalysisScope, nodes: Set<PersonId>, links: Links): PartitionPlan {
        val chapters = scope.chapters
        val stages = minOf(STAGE_MAX, chapters.size / STAGE_MIN_CHAPTERS)
        val reason = when {
            nodes.size < STAGE_MIN_PEOPLE -> "人物较少，无需分区"
            stages < 2 -> "分析章节太少，无法按阶段推断分区"
            else -> null
        }
        if (reason != null) return degraded(reason)
        val segmentOf = chapters.withIndex().associate { (index, chapter) -> chapter to index * stages / chapters.size }
        val stageOf = nodes.mapNotNull { person ->
            val counts = revision.appearances[person].orEmpty().groupingBy { segmentOf.getValue(it) }.eachCount()
            counts.entries.sortedWith(compareBy({ -it.value }, { it.key })).firstOrNull()?.let { person to it.key }
        }.toMap()
        val groups = stageOf.entries.groupBy({ it.value }, { it.key }).toSortedMap()
        if (groups.size < 2) return degraded("人物集中在同一阶段，无法分区")
        val drafts = groups.values.withIndex().map { (index, members) ->
            val name = "第 ${index + 1} 阶段"
            BlockDraft("stage-${index + 1}", name, "stage", PartitionBasis.Inferred(name), members.toSet(), members.toSet())
        }
        val orphans = nodes.filter { it !in stageOf }.toSet()
        val tail = if (orphans.isEmpty()) emptyList() else listOf(unassigned(orphans))
        val placements = drafts.flatMap { d -> d.placed.map { it to Placement(d.id, true) } }.toMap() +
            orphans.associateWith { Placement(UNASSIGNED_ID, false) }
        return PartitionPlan(PartitionMode.INFERRED_STAGES, finish(drafts + tail, links), placements)
    }

    /** 降级方案：没有任何分区块，并写明原因。 */
    private fun degraded(reason: String) = PartitionPlan(PartitionMode.DEGRADED, emptyList(), emptyMap(), reason)

    /** 把草稿按顺序定稿为分区块，并标出块内与同伴都没有连线的成员。 */
    private fun finish(drafts: List<BlockDraft>, links: Links): List<PartitionBlock> =
        drafts.withIndex().map { (index, draft) ->
            val review = if (draft.all.size < REVIEW_MIN_SIZE) emptySet() else draft.all.filter { person ->
                links[person].orEmpty().keys.none { it in draft.all }
            }.toSet()
            PartitionBlock(draft.id, draft.name, draft.kind, index, LayoutPartition(draft.basis, draft.placed), draft.all, review)
        }
}
