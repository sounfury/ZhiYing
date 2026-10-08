// 评分（DESIGN §7.3）：把一个已发布结果版本与评测集逐章对齐，算出指标、漏检原因与禁止项违反。纯计算，不调用模型。
package com.zhiying.domain.evaluation

import com.zhiying.domain.identity.Person
import com.zhiying.domain.identity.PersonId
import com.zhiying.domain.library.Chapter
import com.zhiying.domain.library.ChapterId
import com.zhiying.domain.library.EvidenceRef
import com.zhiying.domain.relations.BuiltInRelationTypes
import com.zhiying.domain.relations.Hardness
import com.zhiying.domain.relations.Direction
import com.zhiying.domain.relations.RelationOccurrence
import com.zhiying.domain.relations.RelationType
import com.zhiying.domain.relations.RelationTypeId
import com.zhiying.domain.relations.SemanticVerdict
import com.zhiying.domain.relations.TypeOrigin
import com.zhiying.domain.revision.AnalysisRevision
import kotlin.math.roundToInt

/** 评分入口。 */
object EvaluationScorer {

    /**
     * 入参：[suite] 评测集；[revision] 该书当前发布的结果版本；[chapters] 该书参与分析的章节（按阅读顺序，第 N 个对应标准第 N 章）。
     * 出参：完整报告。章名不符、章数不符、标准引文找不到只记进标注自检，不中断评分。
     */
    fun score(suite: GoldSuite, revision: AnalysisRevision, chapters: List<Chapter>): EvaluationReport =
        Scoring(suite, revision, chapters).report()
}

/** 名字对齐时忽略的空白与标点。 */
private val IGNORED = Regex("[\\s\\-—_·・,，。.!！?？:：;；()（）\\[\\]【】'\"“”‘’/\\\\]+")

private fun normalize(name: String) = name.replace(IGNORED, "").lowercase()

private val BUILT_IN = BuiltInRelationTypes.library()

/** 标注指定的分档优先；否则按可接受的内置类型推断：含软关系为弱，含硬关系为强，其余为中。 */
private fun tierOf(gold: GoldRelation): Tier {
    gold.tier?.let { return it }
    val hardness = gold.criteria.typeIds.mapNotNull { BUILT_IN[RelationTypeId(it)]?.hardness }.toSet()
    return when {
        Hardness.SOFT in hardness -> Tier.SOFT
        Hardness.HARD in hardness -> Tier.HARD
        else -> Tier.MEDIUM
    }
}

private fun creditOf(check: RelationCheck): Double = check.tier.weight

/** 一次评分的上下文：人物对齐与按章索引的记录只算一次。 */
private class Scoring(
    private val suite: GoldSuite,
    private val revision: AnalysisRevision,
    private val chapters: List<Chapter>,
) {
    private val chaptersById: Map<ChapterId, Chapter> = chapters.associateBy { it.id }
    private val numberOf: Map<ChapterId, Int> = chapters.withIndex().associate { it.value.id to it.index + 1 }
    private val occurrencesByChapter = revision.occurrences.groupBy { it.chapterId }

    /** 规范化名字 → 标准人物名。 */
    private val goldByName: Map<String, String> =
        suite.cast.flatMap { g -> g.names.map { normalize(it) to g.name } }.toMap()

    /** 标准人物名 → 对上的结果人物。 */
    private val aligned: Map<String, Set<PersonId>> = suite.cast.associate { g ->
        g.name to revision.persons.filter { g.name in goldsOf(it) }.map { it.id }.toSet()
    }

    fun report(): EvaluationReport {
        val chapterReports = suite.chapters.map(::chapterReport)
        val people = suite.cast.map { g -> PersonAlignment(g.name, aligned.getValue(g.name).map { personRef(revision.personsById.getValue(it)) }) }
        val wrongMerges = revision.persons.mapNotNull { p -> goldsOf(p).takeIf { it.size > 1 }?.let { WrongMerge(personRef(p), it.sorted()) } }
        val metrics = metrics(people, wrongMerges, chapterReports)
        return EvaluationReport(
            score = (metrics.sumOf { it.weight * (it.value ?: 1.0) } * 100).roundToInt() / 100.0,
            metrics = metrics,
            diagnostics = diagnostics(chapterReports),
            people = people,
            wrongMerges = wrongMerges,
            persons = revision.persons.map(::personRef),
            chapters = chapterReports,
            goldIssues = goldIssues(),
            tiers = tierStats(chapterReports.flatMap { it.required }),
        )
    }

    // ── 人物 ──

    private fun goldsOf(person: Person): Set<String> = person.names.mapNotNullTo(sortedSetOf()) { goldByName[normalize(it)] }

    private fun personRef(p: Person) = PersonRef(p.id.value, p.displayName, p.aliases, p.importance?.name)

    private fun name(id: PersonId): String = revision.personsById[id]?.displayName ?: id.value

    // ── 逐章核对 ──

    private fun chapterReport(gold: GoldChapter): ChapterReport {
        val chapter = chapters.getOrNull(gold.number - 1)
        val occurrences = chapter?.let { occurrencesByChapter[it.id] }.orEmpty()
        val required = gold.required.map { check(it, occurrences) }
        val optional = gold.optional.map { check(it, occurrences) }
        val forbidden = gold.forbidden.map { forbiddenCheck(it, occurrences) }
        val goldPairs = (gold.required + gold.optional).map { it.personA to it.personB } + gold.forbidden.map { it.personA to it.personB }
        val unlabeled = occurrences.filter { o -> o.admitted && goldPairs.none { (a, b) -> between(o, a, b) } }
        return ChapterReport(
            number = gold.number,
            title = gold.title,
            actualTitle = chapter?.title.orEmpty(),
            required = required,
            optional = optional,
            forbidden = forbidden,
            unlabeled = unlabeled.map { it.id.value },
            records = occurrences.map(::recordView),
        )
    }

    /** 记录两端是否正好是这两个标准人物（不论顺序）。 */
    private fun between(o: RelationOccurrence, a: String, b: String): Boolean {
        val pa = aligned[a].orEmpty()
        val pb = aligned[b].orEmpty()
        return (o.key.first in pa && o.key.second in pb) || (o.key.first in pb && o.key.second in pa)
    }

    private fun typeOf(o: RelationOccurrence): RelationType = revision.types[o.key.type]!!

    /**
     * 核对一条标准关系并标出分档；弱关系漏检时，两人本章已有已准入的强 / 中关系就不扣分。
     */
    private fun check(gold: GoldRelation, occurrences: List<RelationOccurrence>): RelationCheck {
        val tier = tierOf(gold)
        val result = match(gold, occurrences).copy(tier = tier)
        if (result.hit || tier != Tier.SOFT) return result
        val strong = occurrences.filter { it.admitted && between(it, gold.personA, gold.personB) && typeOf(it).hardness.strong }
        return if (strong.isEmpty()) result
        else result.copy(excused = true, detail = "两人本章已有强 / 中关系（${strong.joinToString("、") { typeOf(it).name }}），弱关系不扣分")
    }

    private fun match(gold: GoldRelation, occurrences: List<RelationOccurrence>): RelationCheck {
        val missing = listOf(gold.personA, gold.personB).filter { aligned[it].isNullOrEmpty() }
        if (missing.isNotEmpty()) return RelationCheck(gold, false, MissReason.PERSON_MISSING, "未找到人物：${missing.joinToString("、")}")
        val pair = occurrences.filter { between(it, gold.personA, gold.personB) }
        val accepted = pair.filter { gold.criteria.accepts(typeOf(it)) }
        val hits = accepted.filter { it.admitted }
        return when {
            hits.isNotEmpty() -> RelationCheck(
                gold, true, records = hits.map { it.id.value },
                directionCorrect = directionCorrect(gold, hits), quoted = hits.any { o -> o.evidence.any { it.quoted } },
            )
            pair.isEmpty() -> RelationCheck(gold, false, MissReason.NO_RECORD, elsewhere(gold))
            accepted.isNotEmpty() -> RelationCheck(
                gold, false, MissReason.WITHHELD,
                accepted.joinToString("；") { "${typeOf(it).name}：${verdictLabel(it.assessment.verdict)}，${it.assessment.basis}" },
                accepted.map { it.id.value },
            )
            else -> RelationCheck(
                gold, false, MissReason.WRONG_TYPE,
                "本章两人只有：" + pair.joinToString("、") { typeOf(it).name + if (it.admitted) "" else "（${verdictLabel(it.assessment.verdict)}）" },
                pair.map { it.id.value },
            )
        }
    }

    /** 有向内置类型的命中记录中，源端是否是标准写的源端；没有可判方向的记录时为 null。 */
    private fun directionCorrect(gold: GoldRelation, hits: List<RelationOccurrence>): Boolean? {
        val source = aligned[gold.source ?: return null].orEmpty()
        val judged = hits.filter { typeOf(it).let { t -> t.direction is Direction.Directed && t.origin == TypeOrigin.BUILT_IN } }
        return if (judged.isEmpty()) null else judged.any { it.key.first in source }
    }

    /** 本章两人没有记录时，列出两人在哪些章有记录。 */
    private fun elsewhere(gold: GoldRelation): String {
        val numbers = revision.occurrences.filter { between(it, gold.personA, gold.personB) }
            .mapNotNull { numberOf[it.chapterId] }.distinct().sorted()
        return if (numbers.isEmpty()) "全书都没有两人之间的记录" else "本章没有两人之间的记录；第 ${numbers.joinToString("、")} 章有"
    }

    private fun forbiddenCheck(gold: GoldForbidden, occurrences: List<RelationOccurrence>): ForbiddenCheck {
        val violations = occurrences.filter { it.admitted && between(it, gold.personA, gold.personB) && gold.criteria.accepts(typeOf(it)) }
        return ForbiddenCheck(gold, violations.isNotEmpty(), violations.map { it.id.value })
    }

    private fun recordView(o: RelationOccurrence): RecordView {
        val type = typeOf(o)
        return RecordView(
            id = o.id.value,
            personA = name(o.key.first),
            personB = name(o.key.second),
            typeId = type.id.value,
            typeName = type.name,
            directed = type.direction is Direction.Directed,
            admitted = o.admitted,
            verdict = verdictCode(o.assessment.verdict),
            basis = o.assessment.basis,
            evidence = o.evidence.map(::evidenceView),
        )
    }

    private fun evidenceView(e: EvidenceRef): EvidenceView {
        val chapter = chaptersById[e.chapterId]
        return EvidenceView(e.note, e.quotes.map { span -> chapter?.let { runCatching { it.read(span) }.getOrNull() } ?: "" })
    }

    // ── 指标 ──

    private fun metrics(people: List<PersonAlignment>, wrongMerges: List<WrongMerge>, reports: List<ChapterReport>): List<Metric> {
        val cast = people.size
        val splits = people.count { it.matched.size > 1 }
        val required = reports.flatMap { it.required }
        val hits = required.filter { it.hit }
        val forbidden = reports.flatMap { it.forbidden }
        val judged = hits.mapNotNull { it.directionCorrect }
        return listOf(
            Metric("person_recall", "人物召回", people.count { it.matched.isNotEmpty() }, cast, 15),
            Metric("identity", "身份正确", maxOf(0, cast - splits - wrongMerges.size), cast, 15),
            requiredRecall(required),
            Metric("forbidden_avoided", "禁止关系避免", forbidden.count { !it.violated }, forbidden.size, 15),
            Metric("direction", "方向正确", judged.count { it }, judged.size, 10),
            Metric("quoted", "依据附原文", hits.count { it.quoted }, hits.size, 5),
        )
    }

    /** 必有关系召回：按 [Tier] 权重加权；已有强 / 中关系的弱关系漏检不扣分。 */
    private fun requiredRecall(required: List<RelationCheck>): Metric {
        val possible = required.sumOf(::creditOf)
        val earned = required.filter { it.satisfied }.sumOf(::creditOf)
        val note = tierStats(required).filter { it.total > 0 }.joinToString(" · ") { "${it.tier.label} ${it.hit}/${it.total}" }
        return Metric(
            "required_recall", "必有关系召回", required.count { it.satisfied }, required.size, 40,
            ratio = if (possible == 0.0) null else earned / possible, note = note,
        )
    }

    private fun tierStats(required: List<RelationCheck>): List<TierStat> = Tier.entries.map { tier ->
        val checks = required.filter { it.tier == tier }
        TierStat(tier, tier.weight, checks.size, checks.count { it.hit }, checks.count { it.excused })
    }

    private fun diagnostics(reports: List<ChapterReport>): List<Metric> {
        val optional = reports.flatMap { it.optional }
        val records = reports.flatMap { it.records }
        val admitted = records.filter { it.admitted }
        val unlabeled = reports.sumOf { it.unlabeled.size }
        val correct = reports.flatMap { r -> (r.required + r.optional).filter { it.hit }.flatMap { it.records } }.toSet()
        return listOf(
            Metric("optional_coverage", "可有关系覆盖", optional.count { it.hit }, optional.size),
            Metric("adjudicated_precision", "已裁决精度", correct.size, admitted.size - unlabeled),
            Metric("unlabeled", "未标注的已准入记录", unlabeled, admitted.size),
            Metric("withheld", "未准入记录", records.size - admitted.size, records.size),
        )
    }

    // ── 标注自检 ──

    private fun goldIssues(): List<String> {
        val issues = mutableListOf<String>()
        if (chapters.size != suite.chapterCount) issues += "参与分析的章节有 ${chapters.size} 章，评测集写的是 ${suite.chapterCount} 章"
        for (gold in suite.chapters) {
            val chapter = chapters.getOrNull(gold.number - 1)
            when {
                chapter == null -> issues += "第 ${gold.number} 章在导入结果中不存在"
                normalize(chapter.title) != normalize(gold.title) -> issues += "第 ${gold.number} 章标题不符：标准「${gold.title}」，导入后「${chapter.title}」"
            }
            chapter?.let { issues += missingQuotes(gold, it) }
        }
        return issues
    }

    private fun missingQuotes(gold: GoldChapter, chapter: Chapter): List<String> =
        ((gold.required + gold.optional).flatMap { it.evidence } + gold.forbidden.flatMap { it.evidence })
            .filter { it !in chapter.text }
            .map { "第 ${gold.number} 章引文在正文中找不到：「${it.take(24)}${if (it.length > 24) "…" else ""}」" }
}

private fun verdictCode(v: SemanticVerdict): String = when (v) {
    SemanticVerdict.Supported -> "SUPPORTED"
    SemanticVerdict.Refuted -> "REFUTED"
    is SemanticVerdict.Undetermined -> "UNDETERMINED:${v.reason.name}"
}

private fun verdictLabel(v: SemanticVerdict): String = when (v) {
    SemanticVerdict.Supported -> "成立"
    SemanticVerdict.Refuted -> "被否定"
    is SemanticVerdict.Undetermined -> "未决"
}
