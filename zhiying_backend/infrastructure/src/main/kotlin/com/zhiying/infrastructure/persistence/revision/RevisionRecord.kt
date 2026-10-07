// 结果版本的存储记录：把 AnalysisRevision 映射成可用 JSON 序列化的记录类型，再映射回领域对象。
// 领域对象不带任何序列化注解；存储格式的演进只改这里，并递增 FORMAT_VERSION。
package com.zhiying.infrastructure.persistence.revision

import com.zhiying.domain.affiliations.AffiliationGroup
import com.zhiying.domain.affiliations.Affiliations
import com.zhiying.domain.affiliations.GroupId
import com.zhiying.domain.affiliations.Membership
import com.zhiying.domain.identity.Gender
import com.zhiying.domain.identity.Importance
import com.zhiying.domain.identity.NameBinding
import com.zhiying.domain.identity.NameKind
import com.zhiying.domain.identity.Person
import com.zhiying.domain.identity.PersonId
import com.zhiying.domain.library.BookId
import com.zhiying.domain.library.ChapterId
import com.zhiying.domain.library.EvidenceId
import com.zhiying.domain.library.EvidenceRef
import com.zhiying.domain.library.TextRevision
import com.zhiying.domain.library.TextSpan
import com.zhiying.domain.relations.AssessmentSource
import com.zhiying.domain.relations.CandidateId
import com.zhiying.domain.relations.Direction
import com.zhiying.domain.relations.Hardness
import com.zhiying.domain.relations.OccurrenceId
import com.zhiying.domain.relations.RelationAssessment
import com.zhiying.domain.relations.RelationOccurrence
import com.zhiying.domain.relations.RelationType
import com.zhiying.domain.relations.RelationTypeId
import com.zhiying.domain.relations.RelationTypeLibrary
import com.zhiying.domain.relations.SemanticVerdict
import com.zhiying.domain.relations.TypeOrigin
import com.zhiying.domain.relations.UndeterminedReason
import com.zhiying.domain.revision.AnalysisRevision
import com.zhiying.domain.revision.RevisionId

/** 当前存储格式版本；记录结构不兼容地变化时递增，读取时发现不认识的版本直接报错。 */
internal const val FORMAT_VERSION = 1

internal data class SpanRecord(val chapterId: String, val textRevision: Int, val start: Int, val end: Int)

internal data class EvidenceRecord(val id: String, val chapterId: String, val note: String, val quotes: List<SpanRecord>)

internal data class BindingRecord(val name: String, val kind: String, val sourceChapter: String, val basis: String)

internal data class PersonRecord(
    val id: String,
    val bindings: List<BindingRecord>,
    val profile: String?,
    val gender: String,
    val importance: String?,
)

internal data class TypeRecord(
    val id: String,
    val name: String,
    val definition: String,
    val hardness: String,
    val sourceRole: String?,
    val targetRole: String?,
    val synonyms: List<String>,
    val origin: String,
)

internal data class OccurrenceRecord(
    val id: String,
    val first: String,
    val second: String,
    val type: String,
    val chapterId: String,
    val candidate: String,
    val evidence: List<EvidenceRecord>,
    val verdict: String,
    val undeterminedReason: String?,
    val basis: String,
    val source: String,
)

internal data class GroupRecord(val id: String, val name: String, val nameSource: EvidenceRecord)

internal data class MembershipRecord(val group: String, val person: String, val role: String?, val evidence: EvidenceRecord)

/** 一个结果版本的完整存储记录。 */
internal data class RevisionRecord(
    val formatVersion: Int,
    val id: String,
    val bookId: String,
    val analyzedChapters: List<String>,
    val chapterOrder: Map<String, Int>,
    val persons: List<PersonRecord>,
    val types: List<TypeRecord>,
    val occurrences: List<OccurrenceRecord>,
    val groups: List<GroupRecord>,
    val memberships: List<MembershipRecord>,
    val appearances: Map<String, List<String>>,
)

/** 领域对象 → 存储记录。 */
internal fun AnalysisRevision.toRecord(): RevisionRecord = RevisionRecord(
    formatVersion = FORMAT_VERSION,
    id = id.value,
    bookId = bookId.value,
    analyzedChapters = analyzedChapters.map { it.value },
    chapterOrder = chapterOrder.entries.associate { it.key.value to it.value },
    persons = persons.map { it.toRecord() },
    types = types.types.map { it.toRecord() },
    occurrences = occurrences.map { it.toRecord() },
    groups = affiliations.groups.map { GroupRecord(it.id.value, it.name, it.nameSource.toRecord()) },
    memberships = affiliations.memberships.map { MembershipRecord(it.group.value, it.person.value, it.role, it.evidence.toRecord()) },
    appearances = appearances.entries.associate { (person, chapters) -> person.value to chapters.map { it.value } },
)

/** 存储记录 → 领域对象；格式版本不认识时报错，不猜测解释。 */
internal fun RevisionRecord.toDomain(): AnalysisRevision {
    check(formatVersion == FORMAT_VERSION) { "不支持的结果版本存储格式: $formatVersion" }
    val library = RelationTypeLibrary.of(types.map { it.toDomain() })
    return AnalysisRevision(
        id = RevisionId(id),
        bookId = BookId(bookId),
        analyzedChapters = analyzedChapters.mapTo(linkedSetOf()) { ChapterId(it) },
        persons = persons.map { it.toDomain() },
        types = library,
        occurrences = occurrences.map { it.toDomain(library) },
        affiliations = Affiliations(
            groups.map { AffiliationGroup(GroupId(it.id), it.name, it.nameSource.toDomain()) },
            memberships.map { Membership(GroupId(it.group), PersonId(it.person), it.role, it.evidence.toDomain()) },
        ),
        appearances = appearances.entries.associate { (person, chapters) -> PersonId(person) to chapters.mapTo(linkedSetOf()) { ChapterId(it) } },
        chapterOrder = chapterOrder.entries.associate { ChapterId(it.key) to it.value },
    )
}

private fun TextSpan.toRecord() = SpanRecord(chapterId.value, revision.number, start, end)

private fun SpanRecord.toDomain() = TextSpan(ChapterId(chapterId), TextRevision(textRevision), start, end)

private fun EvidenceRef.toRecord() = EvidenceRecord(id.value, chapterId.value, note, quotes.map { it.toRecord() })

private fun EvidenceRecord.toDomain() = EvidenceRef(EvidenceId(id), ChapterId(chapterId), note, quotes.map { it.toDomain() })

private fun Person.toRecord() = PersonRecord(
    id.value,
    bindings.map { BindingRecord(it.name, it.kind.name, it.sourceChapter.value, it.basis) },
    profile,
    gender.name,
    importance?.name,
)

private fun PersonRecord.toDomain(): Person {
    val personId = PersonId(id)
    return Person(
        personId,
        bindings.map { NameBinding(it.name, personId, NameKind.valueOf(it.kind), ChapterId(it.sourceChapter), it.basis) },
        profile,
        Gender.valueOf(gender),
        importance?.let { Importance.valueOf(it) },
    )
}

/** 无向类型的两个角色为 null；有向类型保存源 / 目标角色。 */
private fun RelationType.toRecord(): TypeRecord {
    val directed = direction as? Direction.Directed
    return TypeRecord(
        id.value, name, definition, hardness.name, directed?.sourceRole, directed?.targetRole,
        synonyms.toList(), origin.name,
    )
}

private fun TypeRecord.toDomain(): RelationType {
    val direction = if (sourceRole != null && targetRole != null) Direction.Directed(sourceRole, targetRole) else Direction.Undirected
    return RelationType(
        RelationTypeId(id), name, definition, Hardness.valueOf(hardness), direction,
        synonyms.toSet(), TypeOrigin.valueOf(origin),
    )
}

private fun RelationOccurrence.toRecord(): OccurrenceRecord {
    val verdict = assessment.verdict
    return OccurrenceRecord(
        id = id.value,
        first = key.first.value,
        second = key.second.value,
        type = key.type.value,
        chapterId = chapterId.value,
        candidate = candidate.value,
        evidence = evidence.map { it.toRecord() },
        verdict = when (verdict) {
            SemanticVerdict.Supported -> "SUPPORTED"
            is SemanticVerdict.Undetermined -> "UNDETERMINED"
            SemanticVerdict.Refuted -> "REFUTED"
        },
        undeterminedReason = (verdict as? SemanticVerdict.Undetermined)?.reason?.name,
        basis = assessment.basis,
        source = assessment.source.name,
    )
}

/** 关系键由类型库按方向规则重建（端点顺序已归一，重建结果与存入时一致）。 */
private fun OccurrenceRecord.toDomain(library: RelationTypeLibrary): RelationOccurrence {
    val type = checkNotNull(library[RelationTypeId(type)]) { "存储的关系记录引用了未知类型 $type" }
    val key = checkNotNull(type.keyFor(PersonId(first), PersonId(second))) { "存储的关系记录两端相同: $id" }
    val candidateId = CandidateId(candidate)
    val semantic = when (verdict) {
        "SUPPORTED" -> SemanticVerdict.Supported
        "UNDETERMINED" -> SemanticVerdict.Undetermined(UndeterminedReason.valueOf(checkNotNull(undeterminedReason)))
        "REFUTED" -> SemanticVerdict.Refuted
        else -> error("未知的语义结论: $verdict")
    }
    return RelationOccurrence(
        OccurrenceId(id), key, ChapterId(chapterId), candidateId, evidence.map { it.toDomain() },
        RelationAssessment(candidateId, semantic, basis, AssessmentSource.valueOf(source)),
    )
}
