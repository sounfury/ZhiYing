// 关系类型查询用例：本书类型库（内置 + 书内新增）及各类型在当前已发布结果中的使用次数。
package com.zhiying.application.bookquery

import com.zhiying.application.graphquery.RevisionStore
import com.zhiying.application.library.LibraryQueries
import com.zhiying.domain.library.BookId
import com.zhiying.domain.relations.BuiltInRelationTypes
import com.zhiying.domain.relations.RelationType
import com.zhiying.domain.revision.RevisionId
import org.springframework.stereotype.Service

/**
 * 一种类型及其使用情况：[factCount] 为使用该类型的已准入关系事实数，[occurrenceCount] 为其汇入的记录数；
 * 尚无已发布结果时均为 0。
 */
data class RelationTypeUsage(val type: RelationType, val factCount: Int, val occurrenceCount: Int)

/** 本书类型库；[revision] 为空表示尚无已发布结果，此时只含内置类型。 */
data class RelationTypeView(val bookId: BookId, val revision: RevisionId?, val types: List<RelationTypeUsage>)

/**
 * 查询本书关系类型库。
 *
 * 副作用：读书库确认书存在（不存在抛 NOT_FOUND），再只读一次结果存储。尚无已发布版本时返回内置类型库（使用次数为 0），
 * 因为内置类型本来就是这本书可用的类型。
 */
@Service
class GetRelationTypes(private val store: RevisionStore, private val library: LibraryQueries) {

    /** 入参：[bookId] 书 ID。出参：[RelationTypeView]，类型按库内顺序。 */
    fun execute(bookId: BookId): RelationTypeView {
        library.getBook(bookId)
        val revision = store.findPublished(bookId)
            ?: return RelationTypeView(bookId, null, BuiltInRelationTypes.library().types.map { RelationTypeUsage(it, 0, 0) })
        val facts = revision.facts().groupBy { it.key.type }
        val usages = revision.types.types.map { type ->
            val of = facts[type.id].orEmpty()
            RelationTypeUsage(type, of.size, of.sumOf { it.occurrences.size })
        }
        return RelationTypeView(bookId, revision.id, usages)
    }
}
