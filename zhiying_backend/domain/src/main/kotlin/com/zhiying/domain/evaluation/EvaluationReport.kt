// 评测报告（DESIGN §7.3）：总分与各项指标、人物对齐、逐章的命中 / 漏检原因 / 禁止项违反，以及所评结果的记录快照。
// 只含字符串与数值，便于原样存成运行记录、在评测页展示；不引用人物 ID 等领域值类型。
package com.zhiying.domain.evaluation

/**
 * 一项指标：[hit] / [total]，[weight] 为计入总分的权重（诊断项为 0）。分母为 0 时 [value] 为 null，计分按满分算。
 *
 * 入参：[ratio] 加权比例，给出时取代 hit / total（如必有关系召回按强弱加权）；[note] 计数的补充说明。
 */
data class Metric(
    val key: String,
    val label: String,
    val hit: Int,
    val total: Int,
    val weight: Int = 0,
    val ratio: Double? = null,
    val note: String? = null,
) {
    /** 比例（0~1）；分母为 0 时为 null。 */
    val value: Double? get() = ratio ?: if (total == 0) null else hit.toDouble() / total
}

/** 结果人物的快照。 */
data class PersonRef(val id: String, val name: String, val aliases: List<String>, val importance: String?)

/** 一个标准人物对上的结果人物：为空是缺人物，多于一个是拆分。 */
data class PersonAlignment(val gold: String, val matched: List<PersonRef>)

/** 误合：一个结果人物同时对上多个标准人物。 */
data class WrongMerge(val person: PersonRef, val golds: List<String>)

/** 一条依据的快照：说明与原文片段。 */
data class EvidenceView(val note: String, val quotes: List<String>)

/**
 * 一条关系记录的快照。[verdict] 为 SUPPORTED / REFUTED / UNDETERMINED:<原因>；[directed] 为 true 时 [personA] 是源端。
 */
data class RecordView(
    val id: String,
    val personA: String,
    val personB: String,
    val typeId: String,
    val typeName: String,
    val directed: Boolean,
    val admitted: Boolean,
    val verdict: String,
    val basis: String,
    val evidence: List<EvidenceView>,
)

/** 漏检原因，按顺序判定，取第一条成立的（DESIGN §7.3）。 */
enum class MissReason(val label: String) {
    PERSON_MISSING("缺人物"),
    NO_RECORD("无记录"),
    WITHHELD("未准入"),
    WRONG_TYPE("类型不符"),
}

/**
 * 标准关系的分档与其在必有关系召回中的权重（DESIGN §7.3）。
 *
 * 未在标注中指定时按可接受的内置类型推断：含软关系为弱，否则含硬关系为强，其余（含只认新类型的）为中。
 * 弱关系多是龙套之间的朋友、相识，漏掉只扣少量；两人本章已有强 / 中关系时不扣。
 */
enum class Tier(val label: String, val weight: Double) {
    HARD("强关系", 1.0),
    MEDIUM("中关系", 0.6),
    SOFT("弱关系", 0.3),
}

/** 一档必有关系的统计：[hit] 找到数，[excused] 弱关系漏检但已有强 / 中关系、不扣分的条数。 */
data class TierStat(val tier: Tier, val weight: Double, val total: Int, val hit: Int, val excused: Int = 0)

/**
 * 一条必有 / 可有标准关系的核对结果。
 *
 * 入参：[records] 相关记录 ID（命中时是命中的记录，漏检时是说明原因的记录）；
 * [directionCorrect] 命中且有有向内置类型时方向是否正确，否则为 null；[quoted] 命中记录是否带原文片段；
 * [tier] 分档；[excused] 弱关系漏检，但两人本章已有已准入的强 / 中关系，不扣分。
 */
data class RelationCheck(
    val gold: GoldRelation,
    val hit: Boolean,
    val reason: MissReason? = null,
    val detail: String? = null,
    val records: List<String> = emptyList(),
    val directionCorrect: Boolean? = null,
    val quoted: Boolean = false,
    val tier: Tier = Tier.HARD,
    val excused: Boolean = false,
) {
    /** 是否不扣分：命中，或弱关系漏检但已有强 / 中关系。 */
    val satisfied: Boolean get() = hit || excused
}

/** 一条禁止项的核对结果；[records] 为违反它的记录 ID。 */
data class ForbiddenCheck(val gold: GoldForbidden, val violated: Boolean, val records: List<String>)

/**
 * 一章的核对结果。
 *
 * 入参：[actualTitle] 导入后该章的标题；[unlabeled] 标准没有涉及的人物对上的已准入记录 ID（用于扩充标准）；
 * [records] 本章全部关系记录快照（含未准入）。
 */
data class ChapterReport(
    val number: Int,
    val title: String,
    val actualTitle: String,
    val required: List<RelationCheck>,
    val optional: List<RelationCheck>,
    val forbidden: List<ForbiddenCheck>,
    val unlabeled: List<String>,
    val records: List<RecordView>,
)

/**
 * 一次评分的完整报告。
 *
 * 入参：[score] 总分（0~100）；[metrics] 计分指标；[diagnostics] 不计分的诊断；[people] 标准人物的对齐；
 * [persons] 结果中的全部人物；[goldIssues] 标注自检发现的问题（章名不符、引文找不到等）；[tiers] 必有关系按档统计。
 */
data class EvaluationReport(
    val score: Double,
    val metrics: List<Metric>,
    val diagnostics: List<Metric>,
    val people: List<PersonAlignment>,
    val wrongMerges: List<WrongMerge>,
    val persons: List<PersonRef>,
    val chapters: List<ChapterReport>,
    val goldIssues: List<String>,
    val tiers: List<TierStat> = emptyList(),
)
