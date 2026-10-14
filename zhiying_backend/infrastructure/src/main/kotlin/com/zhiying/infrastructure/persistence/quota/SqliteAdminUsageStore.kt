// 管理员用量聚合：用户用量不随条目删除丢失，书用量按条目统计，不读取私人正文或结果。
package com.zhiying.infrastructure.persistence.quota

import com.zhiying.application.quota.AdminUsageStore
import com.zhiying.application.quota.BookUsage
import com.zhiying.application.quota.UserUsage
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.stereotype.Repository

@Repository
class SqliteAdminUsageStore(
    private val jdbc: JdbcClient,
) : AdminUsageStore {
    override fun users(): List<UserUsage> =
        jdbc
            .sql(
                """SELECT a.id, a.username,
        COALESCE(u.chars, 0) AS chars, COALESCE(u.tokens, 0) AS tokens,
        (SELECT COUNT(*) FROM shelf_items s WHERE s.user_id = a.id) AS books
        FROM accounts a LEFT JOIN (SELECT user_id, SUM(chars) AS chars, SUM(tokens) AS tokens
            FROM usage_ledger GROUP BY user_id) u ON u.user_id = a.id ORDER BY tokens DESC, a.username""",
            ).query {
                rs,
                _,
                ->
                UserUsage(rs.getString("id"), rs.getString("username"), rs.getLong("chars"), rs.getLong("tokens"), rs.getLong("books"))
            }.list()

    override fun books(): List<BookUsage> =
        jdbc
            .sql(
                """SELECT s.id AS item_id, a.username, b.title, COALESCE(u.tokens, 0) AS tokens
        FROM shelf_items s JOIN accounts a ON a.id = s.user_id JOIN books b ON b.id = s.book_id
        LEFT JOIN (SELECT item_id, user_id, SUM(tokens) AS tokens FROM usage_ledger GROUP BY item_id, user_id) u
            ON u.item_id = s.id AND u.user_id = s.user_id
        UNION ALL
        SELECT l.item_id, a.username, '已删除的书', SUM(l.tokens) AS tokens
        FROM usage_ledger l JOIN accounts a ON a.id = l.user_id
        WHERE NOT EXISTS (SELECT 1 FROM shelf_items s WHERE s.id = l.item_id)
        GROUP BY l.item_id, l.user_id ORDER BY tokens DESC, item_id""",
            ).query { rs, _ -> BookUsage(rs.getString("item_id"), rs.getString("username"), rs.getString("title"), rs.getLong("tokens")) }
            .list()
}
