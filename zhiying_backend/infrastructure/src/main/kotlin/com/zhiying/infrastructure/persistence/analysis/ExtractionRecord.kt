// 章抽取的存储记录：把 ChapterExtraction 映射成可用 JSON 序列化的记录类型，再映射回领域对象。
// 领域对象不带序列化注解；存储格式的演进只改这里，并递增 EXTRACTION_FORMAT_VERSION。
// 章内所有引用（局部人物、依据、交流）都属于本章，所以记录里只存局部编号，章 ID 由外层记录统一提供。
package com.zhiying.infrastructure.persistence.analysis

import com.zhiying.domain.extraction.ChapterExtraction
import com.zhiying.domain.extraction.ChapterSummary
import com.zhiying.domain.extraction.ExtractionId
import com.zhiying.domain.extraction.ExtractionProvenance
import com.zhiying.domain.identity.Gender
import com.zhiying.domain.identity.IdentityClaim
import com.zhiying.domain.identity.Importance
import com.zhiying.domain.identity.LocalPersonRef
import com.zhiying.domain.identity.MentionId
import com.zhiying.domain.identity.NameKind
import com.zhiying.domain.identity.PersonId
import com.zhiying.domain.identity.PersonMention
import com.zhiying.domain.library.ChapterId
import com.zhiying.domain.library.EvidenceId
import com.zhiying.domain.library.EvidenceRef
import com.zhiying.domain.library.TextRevision
import com.zhiying.domain.library.TextSpan
import com.zhiying.domain.relations.AssessmentSource
import com.zhiying.domain.relations.CandidateId
import com.zhiying.domain.relations.Direction
import com.zhiying.domain.relations.Hardness
import com.zhiying.domain.relations.InteractionId
import com.zhiying.domain.relations.InteractionObservation
import com.zhiying.domain.relations.RelationAssessment
import com.zhiying.domain.relations.RelationCandidate
import com.zhiying.domain.relations.RelationTypeId
import com.zhiying.domain.relations.SemanticVerdict
import com.zhiying.domain.relations.TypeProposal
import com.zhiying.domain.relations.TypeReference
import com.zhiying.domain.relations.UndeterminedReason

/** 当前抽取存储格式版本；记录结构不兼容地变化时递增，读取时发现不认识的版本直接报错。 */
internal const val EXTRACTION_FORMAT_VERSION = 1

internal data class ExSpan(val textRevision: Int, val start: Int, val end: Int)

internal data class ExEvidence(val id: String, val note: String, val quotes: List<ExSpan>)

internal data class ExMention(val id: String, val person: String, val name: String, val stableKind: String?, val basis: String)

internal data class ExClaim(
    val person: String,
    val existing: String?,
    val basis: String,
    val profile: String?,
    val gender: String,
    val importance: String?,
)

/** 新类型建议；无向类型两个角色为 null。 */
internal data class ExProposal(
    val name: String,
    val definition: String,
    val hardness: String,
    val sourceRole: String?,
    val targetRole: String?,
)

/** 候选引用的类型：[knownType] 与 [proposal] 恰有一个非空。 */
internal data class ExCandidate(
    val id: String,
    val source: String,
    val target: String,
    val knownType: String?,
    val proposal: ExProposal?,
    val description: String,
    val evidence: List<ExEvidence>,
)

internal data class ExAssessment(val candidate: String, val verdict: String, val undeterminedReason: String?, val basis: String)

internal data class ExInteraction(val id: String, val participants: List<String>, val description: String, val evidence: ExEvidence)

/** 一份章抽取的完整存储记录。 */
internal data class ExtractionRecord(
    val formatVersion: Int,
    val id: String,
    val chapterId: String,
    val textRevision: Int,
    val model: String,
    val promptVersion: String,
    val mentions: List<ExMention>,
    val claims: List<ExClaim>,
    val candidates: List<ExCandidate>,
    val assessments: List<ExAssessment>,
    val interactions: List<ExInteraction>,
    val summary: String,
)

/** 领域对象 → 存储记录。 */
internal fun ChapterExtraction.toRecord(): ExtractionRecord = ExtractionRecord(
    formatVersion = EXTRACTION_FORMAT_VERSION,
    id = id.value,
    chapterId = chapterId.value,
    textRevision = provenance.textRevision.number,
    model = provenance.model,
    promptVersion = provenance.promptVersion,
    mentions = mentions.map { ExMention(it.id.value, it.person.key, it.name, it.stableKind?.name, it.basis) },
    claims = claims.map {
        ExClaim(it.person.key, it.existing?.value, it.basis, it.profile, it.gender.name, it.importance?.name)
    },
    candidates = candidates.map { it.toRecord() },
    assessments = firstAssessments.map { it.toRecord() },
    interactions = interactions.map {
        ExInteraction(it.id.value, it.participants.map { p -> p.key }, it.description, it.evidence.toRecord())
    },
    summary = summary.text,
)

/** 存储记录 → 领域对象；格式版本不认识时报错，不猜测解释。 */
internal fun ExtractionRecord.toDomain(): ChapterExtraction {
    check(formatVersion == EXTRACTION_FORMAT_VERSION) { "不支持的章抽取存储格式: $formatVersion" }
    val chapter = ChapterId(chapterId)
    fun person(key: String) = LocalPersonRef(chapter, key)
    return ChapterExtraction(
        id = ExtractionId(id),
        chapterId = chapter,
        provenance = ExtractionProvenance(TextRevision(textRevision), model, promptVersion),
        mentions = mentions.map {
            PersonMention(MentionId(it.id), person(it.person), it.name, it.stableKind?.let { k -> NameKind.valueOf(k) }, it.basis)
        },
        claims = claims.map {
            IdentityClaim(
                person(it.person), it.existing?.let { id -> PersonId(id) }, it.basis, it.profile,
                Gender.valueOf(it.gender), it.importance?.let { i -> Importance.valueOf(i) },
            )
        },
        candidates = candidates.map { it.toDomain(chapter) },
        firstAssessments = assessments.map { it.toDomain() },
        interactions = interactions.map {
            InteractionObservation(InteractionId(it.id), it.participants.mapTo(linkedSetOf(), ::person), it.description, it.evidence.toDomain(chapter))
        },
        summary = ChapterSummary(summary),
    )
}

private fun RelationCandidate.toRecord(): ExCandidate {
    val reference = type
    return ExCandidate(
        id = id.value,
        source = source.key,
        target = target.key,
        knownType = (reference as? TypeReference.Known)?.id?.value,
        proposal = (reference as? TypeReference.Proposed)?.proposal?.let { p ->
            val directed = p.direction as? Direction.Directed
            ExProposal(p.name, p.definition, p.hardness.name, directed?.sourceRole, directed?.targetRole)
        },
        description = description,
        evidence = evidence.map { it.toRecord() },
    )
}

private fun ExCandidate.toDomain(chapter: ChapterId): RelationCandidate {
    val reference = when {
        knownType != null -> TypeReference.Known(RelationTypeId(knownType))
        proposal != null -> {
            val direction = if (proposal.sourceRole != null && proposal.targetRole != null) {
                Direction.Directed(proposal.sourceRole, proposal.targetRole)
            } else {
                Direction.Undirected
            }
            TypeReference.Proposed(TypeProposal(proposal.name, proposal.definition, Hardness.valueOf(proposal.hardness), direction))
        }
        else -> error("存储的候选 $id 既没有已知类型也没有新类型建议")
    }
    return RelationCandidate(
        CandidateId(id), LocalPersonRef(chapter, source), LocalPersonRef(chapter, target), reference,
        description, evidence.map { it.toDomain(chapter) },
    )
}

private fun RelationAssessment.toRecord() = ExAssessment(
    candidate.value,
    when (verdict) {
        SemanticVerdict.Supported -> "SUPPORTED"
        is SemanticVerdict.Undetermined -> "UNDETERMINED"
        SemanticVerdict.Refuted -> "REFUTED"
    },
    (verdict as? SemanticVerdict.Undetermined)?.reason?.name,
    basis,
)

/** 章内首判的来源恒为读章，存储时不单独记录。 */
private fun ExAssessment.toDomain(): RelationAssessment {
    val semantic = when (verdict) {
        "SUPPORTED" -> SemanticVerdict.Supported
        "UNDETERMINED" -> SemanticVerdict.Undetermined(UndeterminedReason.valueOf(checkNotNull(undeterminedReason)))
        "REFUTED" -> SemanticVerdict.Refuted
        else -> error("未知的语义结论: $verdict")
    }
    return RelationAssessment(CandidateId(candidate), semantic, basis, AssessmentSource.CHAPTER_READING)
}

private fun EvidenceRef.toRecord() = ExEvidence(id.value, note, quotes.map { ExSpan(it.revision.number, it.start, it.end) })

private fun ExEvidence.toDomain(chapter: ChapterId) = EvidenceRef(
    EvidenceId(id), chapter, note, quotes.map { TextSpan(chapter, TextRevision(it.textRevision), it.start, it.end) },
)
