// 团体查询用例：当前已发布结果中的团体事实及其成员（含角色与依据）。
package com.zhiying.application.bookquery

import com.zhiying.application.graphquery.RevisionStore
import com.zhiying.application.library.LibraryQueries
import com.zhiying.domain.affiliations.AffiliationGroup
import com.zhiying.domain.identity.Person
import com.zhiying.domain.library.BookId
import com.zhiying.domain.library.ChapterId
import com.zhiying.domain.library.EvidenceRef
import com.zhiying.domain.revision.RevisionId
import org.springframework.stereotype.Service

/** 团体成员：人物、在团体中的角色与归属依据。 */
data class GroupMember(val person: Person, val role: String?, val evidence: EvidenceRef)

/** 一个团体及其成员。 */
data class GroupEntry(val group: AffiliationGroup, val members: List<GroupMember>)

/** 团体列表；[revision] 为空表示尚无已发布结果，此时 [groups] 为空；[numbers] 为章节 ID 到阅读序号的映射。 */
data class AffiliationView(
    val bookId: BookId,
    val revision: RevisionId?,
    val groups: List<GroupEntry>,
    val numbers: Map<ChapterId, Int>,
)

/**
 * 查询团体列表。只返回团体事实，布局推断的分区不在其中（那是图接口 factions 字段的内容）。
 *
 * 副作用：读书库确认书存在（不存在抛 NOT_FOUND），再只读一次结果存储；尚无已发布版本时返回空列表。
 */
@Service
class GetAffiliations(private val store: RevisionStore, private val library: LibraryQueries) {

    /** 入参：[bookId] 书 ID。出参：[AffiliationView]，团体按版本内顺序，成员按人物顺序。 */
    fun execute(bookId: BookId): AffiliationView {
        library.getBook(bookId)
        val revision = store.findPublished(bookId) ?: return AffiliationView(bookId, null, emptyList(), emptyMap())
        val groups = revision.affiliations.groups.map { group ->
            val members = revision.affiliations.memberships.filter { it.group == group.id }
                .map { GroupMember(revision.personsById.getValue(it.person), it.role, it.evidence) }
            GroupEntry(group, members)
        }
        return AffiliationView(bookId, revision.id, groups, revision.chapterNumbers())
    }
}
