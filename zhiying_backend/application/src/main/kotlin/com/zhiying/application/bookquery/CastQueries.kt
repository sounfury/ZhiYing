// 人物查询用例：书内人名册（含出场数与所属团体）与单个人物详情（含其全部关系事实），只读已发布结果版本。
package com.zhiying.application.bookquery

import com.zhiying.application.error.AppException
import com.zhiying.application.error.ErrorCode
import com.zhiying.application.graphquery.RevisionStore
import com.zhiying.application.library.LibraryQueries
import com.zhiying.domain.affiliations.AffiliationGroup
import com.zhiying.domain.identity.Person
import com.zhiying.domain.identity.PersonId
import com.zhiying.domain.library.BookId
import com.zhiying.domain.library.ChapterId
import com.zhiying.domain.library.EvidenceRef
import com.zhiying.domain.relations.Direction
import com.zhiying.domain.relations.RelationFact
import com.zhiying.domain.relations.RelationType
import com.zhiying.domain.relations.RelationTypeLibrary
import com.zhiying.domain.revision.AnalysisRevision
import com.zhiying.domain.revision.RevisionId
import org.springframework.stereotype.Service

/** 人名册排序方式。 */
enum class CastOrder {
    /** 版本内人物顺序（人物建立的先后）。 */
    DEFAULT,

    /** 出场章数从多到少，同数按版本内顺序。 */
    APPEARANCE,
}

/** 名册中的一个人物：人物本身、出场章数（同章多次只计一次）与所属团体（允许多个）。 */
data class CastEntry(val person: Person, val appearanceCount: Int, val groups: List<AffiliationGroup>)

/** 人名册；[revision] 为空表示该书尚无已发布结果，此时 [persons] 为空。 */
data class CastView(val bookId: BookId, val revision: RevisionId?, val persons: List<CastEntry>)

/**
 * 查询书内人名册。
 *
 * 副作用：读书库确认书存在（不存在抛 NOT_FOUND），再只读一次结果存储；尚无已发布版本时返回空名册而不是错误。
 */
@Service
class GetCast(private val store: RevisionStore, private val library: LibraryQueries) {

    /** 入参：[bookId] 书 ID；[order] 排序方式。出参：[CastView]。 */
    fun execute(bookId: BookId, order: CastOrder = CastOrder.DEFAULT): CastView {
        library.getBook(bookId)
        val revision = store.findPublished(bookId) ?: return CastView(bookId, null, emptyList())
        val entries = revision.persons.map { castEntry(revision, it) }
        val sorted = if (order == CastOrder.APPEARANCE) entries.sortedByDescending { it.appearanceCount } else entries
        return CastView(bookId, revision.id, sorted)
    }
}

/** 人物与另一人物之间的一条关系事实（只含已准入记录）。 */
data class PersonRelation(
    val other: Person,
    val type: RelationType,
    /** 本人在关系中的角色；无向关系为 null。 */
    val selfRole: String?,
    /** 对方在关系中的角色；无向关系为 null。 */
    val otherRole: String?,
    /** 有向关系时本人是否为源端（承担源角色）；无向关系为 null。 */
    val outgoing: Boolean?,
    /** 出现章节，按记录顺序。 */
    val chapters: List<ChapterId>,
    val evidence: List<EvidenceRef>,
)

/** 人物在团体中的归属。 */
data class PersonMembership(val group: AffiliationGroup, val role: String?, val evidence: EvidenceRef)

/** 人物详情；[numbers] 是章节 ID 到阅读序号的映射，供展示章号。 */
data class PersonDetail(
    val bookId: BookId,
    val revision: RevisionId,
    val entry: CastEntry,
    val memberships: List<PersonMembership>,
    val relations: List<PersonRelation>,
    val numbers: Map<ChapterId, Int>,
)

/**
 * 查询人物详情：基本信息、团体归属与其全部关系事实。
 *
 * 书不存在、尚无已发布结果或人物不在当前结果版本内，都抛 NOT_FOUND（没有这个人物可返回）。
 */
@Service
class GetPersonDetail(private val store: RevisionStore, private val library: LibraryQueries) {

    /** 入参：[bookId] 书 ID；[personId] 人物 ID。 */
    fun execute(bookId: BookId, personId: PersonId): PersonDetail {
        library.getBook(bookId)
        val revision = store.findPublished(bookId) ?: throw notFound(personId)
        val person = revision.personsById[personId] ?: throw notFound(personId)
        val memberships = revision.affiliations.memberships.filter { it.person == personId }.mapNotNull { m ->
            revision.affiliations.groups.firstOrNull { it.id == m.group }?.let { PersonMembership(it, m.role, m.evidence) }
        }
        val relations = revision.facts()
            .filter { personId == it.key.first || personId == it.key.second }
            .sortedWith(compareBy<RelationFact> { revision.types.getValue(it).hardness }.thenByDescending { it.chapters.size })
            .map { relationOf(revision, personId, it) }
        return PersonDetail(bookId, revision.id, castEntry(revision, person), memberships, relations, revision.chapterNumbers())
    }

    /** 把事实换成以 [self] 为视角的关系：对方人物与两端角色（有向关系按端点方向取）。 */
    private fun relationOf(revision: AnalysisRevision, self: PersonId, fact: RelationFact): PersonRelation {
        val type = revision.types.getValue(fact)
        val isSource = fact.key.first == self
        val other = revision.personsById.getValue(if (isSource) fact.key.second else fact.key.first)
        val directed = type.direction as? Direction.Directed
        val selfRole = directed?.let { if (isSource) it.sourceRole else it.targetRole }
        val otherRole = directed?.let { if (isSource) it.targetRole else it.sourceRole }
        return PersonRelation(other, type, selfRole, otherRole, directed?.let { isSource }, fact.chapters.toList(), fact.evidence)
    }

    private fun notFound(personId: PersonId) = AppException(ErrorCode.NOT_FOUND, "人物不存在: ${personId.value}")
}

/** 取事实对应的类型；版本构造时已校验类型在库内。 */
private fun RelationTypeLibrary.getValue(fact: RelationFact): RelationType =
    this[fact.key.type] ?: error("类型库缺少类型 ${fact.key.type.value}")

/** 由人物组装名册条目。 */
private fun castEntry(revision: AnalysisRevision, person: Person) =
    CastEntry(person, revision.appearanceCount(person.id), revision.affiliations.groupsOf(person.id))
