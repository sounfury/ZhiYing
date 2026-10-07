// 图谱投影：由已发布的结果版本做纯计算，得到 GraphView。
// 顺序固定为：章节聚焦裁剪 → 多标签汇总 → 类型/硬度筛选 → 路人过滤 → 聚焦 → 软标签折叠 → 势力分区。
// 只有已准入的事实参与；未决与否定记录只统计数量，绝不借"更多"混进图里。
package com.zhiying.domain.graph

import com.zhiying.domain.identity.Person
import com.zhiying.domain.identity.PersonId
import com.zhiying.domain.relations.Hardness
import com.zhiying.domain.relations.RelationFact
import com.zhiying.domain.relations.SemanticVerdict
import com.zhiying.domain.revision.AnalysisRevision

/** 人物对（边的两端）。 */
private typealias Pair2 = Pair<PersonId, PersonId>

/** 图谱投影入口，无状态、无副作用。 */
object GraphProjection {

    private val pairOrder = compareBy<Pair2>({ it.first.value }, { it.second.value })
    private val labelOrder = compareByDescending<RelationLabel> { it.score }.thenBy { it.key.type.value }

    /**
     * 从结果版本生成图谱视图。
     *
     * 入参：[revision] 已发布的结果版本；[query] 过滤、聚焦、筛选条件；[scoring] 展示分参数。
     * 出参：[GraphView]。聚焦人物必须是版本内人物，否则抛出 IllegalArgumentException。
     */
    fun project(revision: AnalysisRevision, query: GraphQuery, scoring: DisplayScoring = DisplayScoring()): GraphView {
        query.focus?.let { require(it in revision.personsById) { "聚焦人物不在本结果版本内: ${it.value}" } }
        val scope = scopeOf(revision)
        val cutoff = query.chapterFocus?.number ?: Int.MAX_VALUE
        // 0. 章节聚焦：先按截止章裁剪出现记录与人物出场章（章节序号 <= N）
        val occurrences = revision.occurrences.filter { scope.numberOf(it.chapterId) <= cutoff }
        val appearances = revision.appearances.mapValues { (_, chapters) ->
            chapters.mapNotNullTo(mutableSetOf()) { scope.numberOf(it).takeIf { n -> n <= cutoff } }
        }
        // 1. 多标签汇总，再按类型、硬度筛选
        val labels = RelationFact.aggregate(occurrences).map { labelOf(it, revision, scope, scoring) }.filter { matches(it, query) }
        // 2. 路人过滤：有硬关系的人物与聚焦人物例外；软边不能让人绕过阈值
        val (visible, hidden) = filterPersons(revision, labels, query, appearances)
        // 3. 两端都可见的标签；聚焦时只保留与聚焦人物相连的边，节点只留聚焦人物及其一度关系
        val shown = labels.filter { it.from in visible && it.to in visible && touchesFocus(it, query.focus) }
        val shownPersons = if (query.focus == null) visible else {
            shown.flatMapTo(mutableSetOf(query.focus)) { listOf(it.from, it.to) }
        }
        // 4. 软标签折叠
        val edges = buildEdges(shown)
        // 5. 势力分区
        val plan = PartitionPlanner.plan(revision, scope, shownPersons, edges)
        return GraphView(
            bookId = revision.bookId,
            revision = revision.id,
            scope = scope,
            nodes = shownPersons.sortedBy { it.value }.map { id ->
                val chapters = appearances[id].orEmpty().sorted()
                nodeOf(revision, revision.personsById.getValue(id), chapters, query.chapterFocus, plan)
            },
            edges = edges,
            partitions = plan,
            filter = FilterReport(query.minAppearance, query.focus, hidden),
            withheld = withheldOf(revision),
            chapterFocus = query.chapterFocus,
        )
    }

    /** 分析范围：按阅读序号排列章节；版本未提供序号时按章节 ID 排序后编号。 */
    private fun scopeOf(revision: AnalysisRevision): AnalysisScope {
        val sorted = revision.analyzedChapters
            .sortedWith(compareBy({ revision.chapterOrder[it] ?: Int.MAX_VALUE }, { it.value }))
        val numbers = sorted.withIndex().associate { (index, id) -> id to (revision.chapterOrder[id] ?: (index + 1)) }
        return AnalysisScope(sorted, numbers)
    }

    /** 把一条关系事实转成带展示分的标签；章节按阅读顺序排列。 */
    private fun labelOf(
        fact: RelationFact,
        revision: AnalysisRevision,
        scope: AnalysisScope,
        scoring: DisplayScoring,
    ): RelationLabel {
        val type = revision.types[fact.key.type] ?: error("类型库缺少 ${fact.key.type.value}")
        val chapters = fact.chapters.sortedBy { scope.numberOf(it) }
        val quoted = fact.evidence.any { it.quoted }
        val score = scoring.base(type.hardness) + chapters.size * scoring.perChapter +
            (if (quoted) scoring.quotedEvidenceBonus else 0.0)
        return RelationLabel(fact.key, type, chapters, fact.evidence, fact.occurrences.map { it.id }, score)
    }

    /** 标签是否满足类型与硬度筛选（筛选集合为空表示不限）。 */
    private fun matches(label: RelationLabel, query: GraphQuery): Boolean =
        (query.types.isEmpty() || label.key.type in query.types) &&
            (query.hardness.isEmpty() || label.hardness in query.hardness)

    /** 标签是否与聚焦人物相连；未聚焦时恒为真。 */
    private fun touchesFocus(label: RelationLabel, focus: PersonId?): Boolean =
        focus == null || label.from == focus || label.to == focus

    /**
     * 路人过滤：按章计数，出场章数达到阈值、有硬关系、或是聚焦人物才可见。
     * 章节聚焦时 [appearances] 已按截止章裁剪：单章模式只留第 N 章出场者且不做阈值过滤；累计模式只考虑前 N 章出场过的人物。
     * 出参：可见人物集合，以及被隐藏人物名单（仅含确有出场或关系的人物）。
     */
    private fun filterPersons(
        revision: AnalysisRevision,
        labels: List<RelationLabel>,
        query: GraphQuery,
        appearances: Map<PersonId, Set<Int>>,
    ): Pair<Set<PersonId>, List<HiddenPerson>> {
        val chapterFocus = query.chapterFocus
        val hardPersons = labels.filter { it.hardness == Hardness.HARD }.flatMap { listOf(it.from, it.to) }.toSet()
        val related = labels.flatMap { listOf(it.from, it.to) }.toSet()
        val visible = linkedSetOf<PersonId>()
        val hidden = mutableListOf<HiddenPerson>()
        for (person in revision.persons.sortedBy { it.id.value }) {
            val count = appearances[person.id]?.size ?: 0
            val keep = isVisible(person.id, appearances[person.id].orEmpty(), query, person.id in hardPersons)
            when {
                keep -> visible += person.id
                chapterFocus != null && (chapterFocus.mode == ChapterMode.SINGLE || count == 0) -> Unit
                count > 0 || person.id in related ->
                    hidden += HiddenPerson(person.id, person.displayName, count, HideReason.BELOW_MIN_APPEARANCE)
            }
        }
        return visible to hidden
    }

    /** 人物是否可见：聚焦人物例外；单章只看本章出场者；累计须前 N 章出场过；其余按阈值与硬关系例外。 */
    private fun isVisible(person: PersonId, chapters: Set<Int>, query: GraphQuery, hard: Boolean): Boolean {
        val chapterFocus = query.chapterFocus
        return when {
            person == query.focus -> true
            chapterFocus?.mode == ChapterMode.SINGLE -> chapterFocus.number in chapters
            chapterFocus != null && chapters.isEmpty() -> false
            else -> chapters.size >= query.minAppearance || hard
        }
    }

    /**
     * 组装边并折叠软标签：同一人物对（不分方向）已有硬 / 中标签时，软标签进入 folded，不删除。
     * 折叠标签挂在自己所在有序人物对的边上；该方向没有可见标签时挂到该人物对的第一条强边。
     */
    private fun buildEdges(shown: List<RelationLabel>): List<GraphEdge> {
        val strongPairs = shown.filter { it.hardness.strong }.map { unordered(it.from to it.to) }.toSet()
        val (folded, visible) = shown.partition { it.hardness == Hardness.SOFT && unordered(it.from to it.to) in strongPairs }
        val visibleByPair = visible.groupBy { it.from to it.to }
        val foldedByPair = folded.groupBy { label ->
            val own = label.from to label.to
            if (own in visibleByPair) own else visibleByPair.keys.filter { unordered(it) == unordered(own) }.minWith(pairOrder)
        }
        return (visibleByPair.keys + foldedByPair.keys).sortedWith(pairOrder).map { pair ->
            GraphEdge(
                first = pair.first,
                second = pair.second,
                labels = visibleByPair[pair].orEmpty().sortedWith(labelOrder),
                folded = foldedByPair[pair].orEmpty().sortedWith(labelOrder),
            )
        }
    }

    /** 无序人物对（按 ID 排序归一）。 */
    private fun unordered(pair: Pair2): Pair2 = if (pair.first.value <= pair.second.value) pair else pair.second to pair.first

    /** 由人物与分区方案生成节点；[chapters] 为（按聚焦范围裁剪后的）出场章节阅读序号，升序。 */
    private fun nodeOf(
        revision: AnalysisRevision,
        person: Person,
        chapters: List<Int>,
        chapterFocus: ChapterFocus?,
        plan: PartitionPlan,
    ): GraphNode {
        val placement = plan.placements[person.id]
        val blockIds = plan.blocks.map { it.id }.toSet()
        return GraphNode(
            person = person.id,
            name = person.displayName,
            aliases = person.aliases,
            gender = person.gender,
            importance = person.importance,
            bio = if (chapterFocus?.mode == ChapterMode.SINGLE) "" else person.profile.orEmpty(),
            appearanceCount = chapters.size,
            chapters = chapters,
            groups = revision.affiliations.groupsOf(person.id).map { it.id }.filter { it.value in blockIds },
            partition = placement?.blockId,
            placementInferred = placement?.inferred ?: false,
        )
    }

    /** 统计未决与否定的记录数；这些记录不进图。 */
    private fun withheldOf(revision: AnalysisRevision): WithheldCounts {
        val verdicts = revision.occurrences.map { it.assessment.verdict }
        return WithheldCounts(
            undetermined = verdicts.count { it is SemanticVerdict.Undetermined },
            refuted = verdicts.count { it == SemanticVerdict.Refuted },
        )
    }
}
