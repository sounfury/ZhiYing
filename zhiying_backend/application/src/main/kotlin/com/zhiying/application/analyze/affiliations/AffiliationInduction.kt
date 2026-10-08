// 团体归纳步骤：全书级独立步骤，在人物与关系定稿之后运行；组装有界输入、调用归纳端口、把结果校验为领域团体并产出新版本。
package com.zhiying.application.analyze.affiliations

import com.zhiying.application.bookquery.chapterNumbers
import com.zhiying.application.llm.ModelCallControl
import com.zhiying.domain.affiliations.AffiliationGroup
import com.zhiying.domain.affiliations.Affiliations
import com.zhiying.domain.affiliations.GroupId
import com.zhiying.domain.affiliations.Membership
import com.zhiying.domain.extraction.ChapterExtraction
import com.zhiying.domain.identity.Importance
import com.zhiying.domain.identity.Person
import com.zhiying.domain.library.ChapterId
import com.zhiying.domain.library.EvidenceId
import com.zhiying.domain.library.EvidenceRef
import com.zhiying.domain.revision.AnalysisRevision
import org.apache.commons.logging.LogFactory
import org.springframework.stereotype.Service

/**
 * 团体归纳输入的有界裁剪上限（由配置装配）：名册按重要度与出场数取前 [maxPersons] 人，
 * 章摘要超过 [maxChapters] 章时均匀抽样；各文本按字数截断；关系骨架取出现章数最多的前 [maxRelations] 条。
 */
data class AffiliationSettings(
    val maxPersons: Int = 300,
    val maxProfileChars: Int = 60,
    val maxChapters: Int = 200,
    val maxSummaryChars: Int = 200,
    val maxObservationsPerChapter: Int = 3,
    val maxObservationChars: Int = 80,
    val maxRelations: Int = 220,
)

/**
 * 团体归纳的结果：新版本，以及没有产出团体时的原因（[problem] 为 null 表示已写入团体）。
 * 原因会写进任务终态说明，避免「势力分区」静默退化却无人知道。
 */
data class InductionOutcome(val revision: AnalysisRevision, val problem: String?)

/**
 * 团体归纳用例（DESIGN §3.6：全书级独立步骤，逐章猜会造出不一致的块名）。
 *
 * 副作用顺序：纯计算组装输入 → 一次模型调用（经 [AffiliationInducer]）→ 纯计算校验并转成领域团体。
 * 归纳失败或没有可用结果时原样返回版本，不伪造团体；布局用的推断分区不在这里生成。
 */
@Service
class AffiliationInduction(private val inducer: AffiliationInducer, private val settings: AffiliationSettings) {

    private val log = LogFactory.getLog(AffiliationInduction::class.java)

    /**
     * 为 [revision] 归纳团体。
     *
     * 入参：[revision] 已定稿人物与关系的版本；[extractions] 各章抽取（提供摘要与观察）；[control] 任务级预算与取消。
     * 出参：带新团体的新版本（其余字段原样复制）；失败或无结果时返回原版本，并附原因。
     */
    fun run(revision: AnalysisRevision, extractions: List<ChapterExtraction>, control: ModelCallControl): InductionOutcome {
        if (revision.persons.isEmpty() || revision.analyzedChapters.isEmpty()) return InductionOutcome(revision, "没有人物，跳过团体归纳")
        // 1. 组装有界输入
        val request = buildRequest(revision, extractions)
        // 2. 调模型（失败以结果表达）
        val induced = when (val result = inducer.induce(request, control)) {
            is InductionResult.Failed -> return skipped(revision, result.message)
            is InductionResult.Induced -> result.groups
        }
        // 3. 校验并转成领域团体
        val affiliations = toAffiliations(revision, induced)
            ?: return skipped(revision, "团体归纳没有可用团体（模型返回 ${induced.size} 个，校验后为 0）")
        return InductionOutcome(AnalysisRevision(
            id = revision.id,
            bookId = revision.bookId,
            analyzedChapters = revision.analyzedChapters,
            persons = revision.persons,
            types = revision.types,
            occurrences = revision.occurrences,
            affiliations = affiliations,
            appearances = revision.appearances,
            chapterOrder = revision.chapterOrder,
        ), null)
    }

    /** 没有产出团体：记日志并原样返回版本。 */
    private fun skipped(revision: AnalysisRevision, problem: String): InductionOutcome {
        log.warn("书 ${revision.bookId.value} 未写入团体：$problem")
        return InductionOutcome(revision, problem)
    }

    /** 组装请求：名册、章摘要与观察、关系骨架都有界裁剪。 */
    private fun buildRequest(revision: AnalysisRevision, extractions: List<ChapterExtraction>): AffiliationRequest {
        val numbers = revision.chapterNumbers()
        val persons = revision.persons
            .sortedWith(
                compareBy<Person> { importanceRank(it.importance) }
                    .thenByDescending { revision.appearanceCount(it.id) }
                    .thenBy { it.id.value },
            )
            .take(settings.maxPersons)
            .map { p ->
                val appearances = revision.appearances[p.id].orEmpty().mapNotNull { numbers[it] }.sorted()
                InductionPerson(p.copy(profile = p.profile?.let { clip(it, settings.maxProfileChars) }), appearances)
            }
        val kept = persons.mapTo(mutableSetOf()) { it.person.id }
        val chapters = sampled(
            extractions.filter { it.chapterId in numbers }.sortedBy { numbers.getValue(it.chapterId) },
            settings.maxChapters,
        ).map { e ->
            InductionChapter(
                number = numbers.getValue(e.chapterId),
                chapterId = e.chapterId,
                summary = clip(e.summary.text, settings.maxSummaryChars),
                observations = e.interactions.take(settings.maxObservationsPerChapter)
                    .map { clip(it.description, settings.maxObservationChars) },
            )
        }
        val relations = revision.facts()
            .filter { it.key.first in kept && it.key.second in kept }
            .sortedByDescending { it.chapters.size }
            .take(settings.maxRelations)
            .map { f ->
                InductionRelation(
                    f.key.first, f.key.second, revision.types[f.key.type]?.name ?: f.key.type.value,
                    f.chapters.mapNotNull { numbers[it] }.sorted(),
                )
            }
        return AffiliationRequest(persons, chapters, relations, forbiddenNames(revision))
    }

    /** 不能当团体名的词：本书全部关系类型名、同义名与反向称呼。 */
    private fun forbiddenNames(revision: AnalysisRevision): Set<String> =
        revision.types.types.flatMapTo(linkedSetOf()) { it.allNames }

    /**
     * 把模型结果转成领域团体：丢弃空名、重名、纯关系词、未知人物与重复成员；没有任何有效团体时返回 null。
     * 依据章取成员活跃章中第一个有效章，缺省退回其首次出场章。
     */
    private fun toAffiliations(revision: AnalysisRevision, induced: List<InducedGroup>): Affiliations? {
        val numbers = revision.chapterNumbers()
        val forbidden = forbiddenNames(revision)
        val seen = mutableSetOf<String>()
        val groups = mutableListOf<AffiliationGroup>()
        val memberships = mutableListOf<Membership>()
        fun chapterOf(m: InducedMember): ChapterId =
            m.chapters.firstOrNull { it in numbers }
                ?: revision.appearances[m.person].orEmpty().filter { it in numbers }.minByOrNull { numbers.getValue(it) }
                ?: numbers.keys.first()
        for (g in induced) {
            val name = g.name.trim()
            val members = g.members.filter { it.person in revision.personsById }.distinctBy { it.person }
            if (name.isEmpty() || name in forbidden || !seen.add(name) || members.isEmpty()) continue
            val id = GroupId("g%03d".format(groups.size + 1))
            val nameNote = text(g.note) ?: "全书归纳识别的团体：$name"
            groups += AffiliationGroup(id, name, EvidenceRef(EvidenceId("${id.value}-name"), chapterOf(members.first()), nameNote))
            members.forEachIndexed { index, m ->
                val base = text(m.note) ?: "${revision.personsById.getValue(m.person).displayName}属于$name"
                val note = text(m.quote)?.let { "$base（原文：$it）" } ?: base
                val evidence = EvidenceRef(EvidenceId("${id.value}-m${index + 1}"), chapterOf(m), note)
                memberships += Membership(id, m.person, text(m.role), evidence)
            }
        }
        return if (groups.isEmpty()) null else Affiliations(groups, memberships)
    }

    /** 去首尾空白；空则为 null。 */
    private fun text(raw: String?): String? = raw?.trim()?.takeIf { it.isNotEmpty() }

    /** 重要度排序权重：主角、配角、其余（含未标注）。 */
    private fun importanceRank(importance: Importance?): Int = when (importance) {
        Importance.PROTAGONIST -> 0
        Importance.SUPPORTING -> 1
        else -> 2
    }

    /** 折叠空白并按字数截断。 */
    private fun clip(text: String, max: Int): String {
        val flat = text.trim().replace(Regex("\\s+"), " ")
        return if (flat.length > max) flat.take(max) + "…" else flat
    }

    /** 超过上限时均匀抽样，保持原顺序。 */
    private fun <T> sampled(items: List<T>, max: Int): List<T> =
        if (items.size <= max) items else (0 until max).map { items[it * items.size / max] }
}
