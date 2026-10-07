// 全书简介步骤：在软兜底之后、组装结果版本之前，为重要人物把首章简介改写成概括多章经历的全书简介。
package com.zhiying.application.analyze.profile

import com.zhiying.application.analyze.BatchLimits
import com.zhiying.application.analyze.boundedBatches
import com.zhiying.application.llm.ModelCallControl
import com.zhiying.domain.extraction.ChapterExtraction
import com.zhiying.domain.identity.AlignedIdentities
import com.zhiying.domain.identity.LocalPersonRef
import com.zhiying.domain.identity.Person
import com.zhiying.domain.identity.PersonId
import com.zhiying.domain.library.ChapterId
import com.zhiying.domain.relations.RelationOccurrence
import com.zhiying.domain.relations.RelationTypeLibrary
import com.zhiying.domain.relations.coreOf
import org.apache.commons.logging.LogFactory

/**
 * 全书简介的批量与材料上限。
 * [batch] 单次请求的人数与近似输入字符数上限；[mentionsPerChapter] 每章最多附带的提及依据条数；
 * [maxChaptersPerPerson] 每人最多使用的章数，超过时均匀抽样并保留首末章；[enabled] 关闭时整个步骤跳过。
 */
data class ProfileLimits(
    val batch: BatchLimits = BatchLimits(maxItems = 8, maxChars = 12_000),
    val mentionsPerChapter: Int = 3,
    val maxChaptersPerPerson: Int = 12,
    val enabled: Boolean = true,
) {
    init {
        require(mentionsPerChapter >= 1 && maxChaptersPerPerson >= 1) { "全书简介的材料上限必须为正" }
    }
}

/** 全书简介统计：[important] 重要人物数；[requested] 本次需要重写而发出请求的人数；[written] 实际写入新简介的人数。 */
data class ProfileStats(val important: Int = 0, val requested: Int = 0, val written: Int = 0)

/** 简介步骤产物：更新简介后的人物列表（顺序不变）与统计。 */
data class ProfileOutcome(val persons: List<Person>, val stats: ProfileStats)

/**
 * 全书简介步骤（应用层编排，非 Spring Bean）。
 *
 * 顺序：判定重要人物 → 按章抽取汇集各人物的章材料（身份映射把局部人物对到书内人物，不读原文）→
 * 分批交给 [ProfileWriter]（副作用：模型调用）→ 逐人覆盖简介。失败、预算耗尽或未回答的人物保留原简介，非法回答丢弃并记日志，
 * 任何情况都不阻断发布。
 */
class ProfileStep(
    private val writer: ProfileWriter,
    private val limits: ProfileLimits = ProfileLimits(),
    private val control: ModelCallControl = ModelCallControl(),
    private val coreMinAppearance: Int = 2,
) {
    private val log = LogFactory.getLog(ProfileStep::class.java)

    /**
     * 为重要人物生成全书简介。
     * 入参：[identities] 对齐产物；[extractions] 各章抽取（阅读顺序）；[occurrences] 本次结果的全部关系记录，
     * 用于判断"有已成立的硬 / 中关系"；[library] 类型库（判断硬度）；
     * [rerunChapter] 单章重跑时的被重跑章：只重写在该章出场的重要人物，其余沿用已有简介；整书分析传 null。
     */
    fun run(
        identities: AlignedIdentities,
        extractions: List<ChapterExtraction>,
        occurrences: List<RelationOccurrence>,
        library: RelationTypeLibrary,
        rerunChapter: ChapterId? = null,
        chapterOrder: Map<ChapterId, Int> = emptyMap(),
    ): ProfileOutcome {
        if (!limits.enabled) return ProfileOutcome(identities.persons, ProfileStats())
        val important = importantPersons(identities, occurrences, library)
        val targets = identities.persons.filter {
            it.id in important && (rerunChapter == null || rerunChapter in identities.appearances[it.id].orEmpty())
        }
        if (targets.isEmpty()) return ProfileOutcome(identities.persons, ProfileStats(important.size))
        val materials = materialsOf(identities, extractions, chapterOrder)
        val subjects = targets.map { ProfileSubject(it, sampleEvenly(materials[it.id].orEmpty(), limits.maxChaptersPerPerson)) }
        val written = boundedBatches(subjects, limits.batch) { it.size }.flatMap { ask(it).entries }.associate { it.key to it.value }
        val persons = identities.persons.map { person -> written[person.id]?.let(person::withProfile) ?: person }
        return ProfileOutcome(persons, ProfileStats(important.size, subjects.size, written.size))
    }

    /** 重要人物：出场章数达标，或在本次结果中有已成立（准入）的硬 / 中关系。 */
    private fun importantPersons(
        identities: AlignedIdentities,
        occurrences: List<RelationOccurrence>,
        library: RelationTypeLibrary,
    ): Set<PersonId> {
        val inStrongRelation = occurrences
            .filter { it.admitted && library[it.key.type]?.hardness?.strong == true }
            .flatMap { listOf(it.key.first, it.key.second) }
        return coreOf(identities.appearances, coreMinAppearance) + inStrongRelation
    }

    /**
     * 汇集每个书内人物按阅读顺序的各章材料；未绑定到人物的局部人物不参与。
     * 章号取参与分析的章节里排第几（从 1 起），不用书内序号——后者把目录、导读等不参与分析的部分也算进去，
     * 模型会把它写进简介（如「第 10 章中」而实际是正文第二章）。
     */
    private fun materialsOf(
        identities: AlignedIdentities,
        extractions: List<ChapterExtraction>,
        chapterOrder: Map<ChapterId, Int>,
    ): Map<PersonId, List<ChapterMaterial>> {
        val number = extractions.map { it.chapterId }.distinct()
            .sortedWith(compareBy({ chapterOrder[it] ?: Int.MAX_VALUE }, { it.value }))
            .withIndex().associate { (i, id) -> id to i + 1 }
        val result = linkedMapOf<PersonId, MutableList<ChapterMaterial>>()
        for (extraction in extractions) {
            val byPerson = extraction.persons.groupBy { identities.identityMap.resolve(it) }
            for ((personId, locals) in byPerson) {
                if (personId != null) result.getOrPut(personId) { mutableListOf() } += chapterMaterial(extraction, locals.toSet(), number[extraction.chapterId])
            }
        }
        return result
    }

    /** 某人物在一章里的材料：该章主张里第一条非空简介，以及去重、限条数的提及依据。 */
    private fun chapterMaterial(extraction: ChapterExtraction, locals: Set<LocalPersonRef>, number: Int?): ChapterMaterial {
        val profile = extraction.claims.filter { it.person in locals }.firstNotNullOfOrNull { it.profile?.takeIf(String::isNotBlank) }
        val bases = extraction.mentions.filter { it.person in locals }.map { it.basis.trim() }.distinct().take(limits.mentionsPerChapter)
        return ChapterMaterial(extraction.chapterId, profile?.trim(), bases, number)
    }

    /** 调用一批并校验回答：只收请求内人物的非空简介，其余丢弃并记日志。 */
    private fun ask(batch: List<ProfileSubject>): Map<PersonId, String> {
        val asked = batch.mapTo(mutableSetOf()) { it.person.id }
        val accepted = linkedMapOf<PersonId, String>()
        for (answer in writer.write(ProfileRequest(batch, control))) {
            val text = answer.text.trim()
            when {
                answer.person !in asked -> log.warn("丢弃全书简介：人物不在本批请求内 ${answer.person.value}")
                text.isEmpty() -> log.warn("丢弃全书简介：内容为空 ${answer.person.value}")
                else -> accepted.putIfAbsent(answer.person, text)
            }
        }
        return accepted
    }
}

/** 从 [items] 中均匀抽取不超过 [max] 项，保持顺序并保留首末项；不超过上限时原样返回。 */
internal fun <T> sampleEvenly(items: List<T>, max: Int): List<T> {
    if (items.size <= max) return items
    if (max == 1) return items.take(1)
    val last = items.size - 1
    return (0 until max).map { items[(it.toLong() * last / (max - 1)).toInt()] }
}
