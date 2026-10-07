// 结果版本的 SQLite 实现：版本整体序列化成带格式版本号的 JSON 存一行，发布只切换指针。
package com.zhiying.infrastructure.persistence.revision

import com.zhiying.application.graphquery.RevisionStore
import com.zhiying.domain.library.BookId
import com.zhiying.domain.revision.AnalysisRevision
import com.zhiying.domain.revision.RevisionId
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.stereotype.Repository
import org.springframework.transaction.support.TransactionTemplate
import tools.jackson.module.kotlin.jacksonObjectMapper
import tools.jackson.module.kotlin.readValue

/**
 * [RevisionStore] 的 SQLite 实现。
 *
 * 保存与发布各是一个短事务，模型调用不在事务内；查询经"指针 → 版本行"读取，版本行一经写入不再修改，
 * 因此一次查询只会看到一个完整版本。
 */
@Repository
class SqliteRevisionStore(
    private val jdbc: JdbcClient,
    private val transactions: TransactionTemplate,
) : RevisionStore {

    private val mapper = jacksonObjectMapper()

    /** 序列化并插入一行；版本不可变，同 ID 重复保存会因主键冲突失败。 */
    override fun save(revision: AnalysisRevision) {
        val payload = mapper.writeValueAsString(revision.toRecord())
        jdbc.sql("INSERT INTO analysis_revision (revision_id, book_id, format_version, payload) VALUES (?, ?, ?, ?)")
            .params(revision.id.value, revision.bookId.value, FORMAT_VERSION, payload)
            .update()
    }

    /** 短事务内校验版本归属后切换指针。 */
    override fun publish(bookId: BookId, revision: RevisionId) {
        transactions.executeWithoutResult { switchPointer(bookId, revision) }
    }

    /** 短事务内先比对当前指针，一致才切换。 */
    override fun publishIfCurrent(bookId: BookId, revision: RevisionId, expected: RevisionId?): Boolean =
        transactions.execute {
            if (publishedId(bookId) != expected) false else {
                switchPointer(bookId, revision)
                true
            }
        } ?: false

    /** 校验版本存在且属于该书，然后插入或更新该书的已发布指针。 */
    private fun switchPointer(bookId: BookId, revision: RevisionId) {
        val owner = jdbc.sql("SELECT book_id FROM analysis_revision WHERE revision_id = ?")
            .param(revision.value).query(String::class.java).optional().orElse(null)
        require(owner == bookId.value) { "结果版本 ${revision.value} 不存在或不属于书 ${bookId.value}" }
        jdbc.sql(
            "INSERT INTO published_revision (book_id, revision_id) VALUES (?, ?) " +
                "ON CONFLICT(book_id) DO UPDATE SET revision_id = excluded.revision_id, " +
                "published_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
        ).params(bookId.value, revision.value).update()
    }

    override fun publishedId(bookId: BookId): RevisionId? =
        jdbc.sql("SELECT revision_id FROM published_revision WHERE book_id = ?")
            .param(bookId.value).query(String::class.java).optional().map { RevisionId(it) }.orElse(null)

    /** 一条 SQL 连接指针与版本行，保证读到的是同一个版本。 */
    override fun findPublished(bookId: BookId): AnalysisRevision? =
        jdbc.sql(
            "SELECT r.payload FROM published_revision p JOIN analysis_revision r ON r.revision_id = p.revision_id " +
                "WHERE p.book_id = ?",
        ).param(bookId.value).query(String::class.java).optional().map(::decode).orElse(null)

    override fun find(revision: RevisionId): AnalysisRevision? =
        jdbc.sql("SELECT payload FROM analysis_revision WHERE revision_id = ?")
            .param(revision.value).query(String::class.java).optional().map(::decode).orElse(null)

    /** 反序列化为领域对象。 */
    private fun decode(payload: String): AnalysisRevision = mapper.readValue<RevisionRecord>(payload).toDomain()
}
