// SQLite 反馈存储：只追加用户报告，按条目读取快照，不联查或暴露私人书的分析数据。
package com.zhiying.infrastructure.persistence.feedback

import com.zhiying.application.feedback.FeedbackStore
import com.zhiying.domain.feedback.Feedback
import com.zhiying.domain.feedback.FeedbackCategory
import com.zhiying.domain.feedback.FeedbackTarget
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.stereotype.Repository
import java.time.Instant

@Repository
class SqliteFeedbackStore(
    private val jdbc: JdbcClient,
) : FeedbackStore {
    override fun save(feedback: Feedback) {
        jdbc
            .sql(
                """INSERT INTO feedback (id, created_at, user_id, item_id, book_id, book_title, revision_id,
                target_kind, target_ref, target_label, category, note, scope)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            ).params(
                listOf(
                    feedback.id,
                    feedback.createdAt.toString(),
                    feedback.userId,
                    feedback.itemId,
                    feedback.bookId,
                    feedback.bookTitle,
                    feedback.revisionId,
                    feedback.targetKind.name,
                    feedback.targetRef,
                    feedback.targetLabel,
                    feedback.category?.name,
                    feedback.note,
                    feedback.scope,
                ),
            ).update()
    }

    override fun list(itemId: String?): List<Feedback> {
        val query =
            if (itemId == null) {
                jdbc.sql("SELECT * FROM feedback ORDER BY created_at DESC, id")
            } else {
                jdbc.sql("SELECT * FROM feedback WHERE item_id = ? ORDER BY created_at DESC, id").param(itemId)
            }
        return query
            .query { rs, _ ->
                Feedback(
                    rs.getString("id"),
                    Instant.parse(rs.getString("created_at")),
                    rs.getString("user_id"),
                    rs.getString("item_id"),
                    rs.getString("book_id"),
                    rs.getString("book_title"),
                    rs.getString("revision_id"),
                    FeedbackTarget.valueOf(rs.getString("target_kind")),
                    rs.getString("target_ref"),
                    rs.getString("target_label"),
                    rs.getString("category")?.let(FeedbackCategory::valueOf),
                    rs.getString("note"),
                    rs.getString("scope"),
                )
            }.list()
    }
}
