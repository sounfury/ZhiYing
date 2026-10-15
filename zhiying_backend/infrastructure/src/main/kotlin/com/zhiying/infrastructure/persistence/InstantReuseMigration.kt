// 表结构兼容迁移：补版本列、TXT 分章方案列与模型服务商列，并将旧书主迁为同 ID 条目，旧结果仍可读但不可秒传。
package com.zhiying.infrastructure.persistence

import org.springframework.beans.factory.InitializingBean
import org.springframework.boot.sql.init.dependency.DependsOnDatabaseInitialization
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.stereotype.Component
import org.springframework.transaction.support.TransactionTemplate

@Component
@DependsOnDatabaseInitialization
class InstantReuseMigration(
    private val jdbc: JdbcClient,
    private val transactions: TransactionTemplate,
) : InitializingBean {
    override fun afterPropertiesSet() {
        transactions.executeWithoutResult {
            addColumn("books", "import_version", "INTEGER NOT NULL DEFAULT 1")
            addColumn("books", "split_rule", "TEXT")
            addColumn("model_settings", "provider_id", "TEXT NOT NULL DEFAULT 'default'")
            addColumn("analysis_revision", "method_version", "TEXT")
            addColumn("analysis_revision", "full_book", "INTEGER NOT NULL DEFAULT 0")
            val old =
                jdbc
                    .sql("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'book_owners'")
                    .query(Int::class.java)
                    .single() > 0
            if (old) {
                jdbc
                    .sql(
                        """INSERT INTO shelf_items (id, user_id, book_id, original_name, created_at)
                    SELECT b.id, o.user_id, b.id, b.original_name, b.imported_at
                    FROM book_owners o JOIN books b ON b.id = o.book_id""",
                    ).update()
                jdbc.sql("DROP TABLE book_owners").update()
            }
            val ledgerColumns = jdbc.sql("PRAGMA table_info(usage_ledger)").query { rs, _ -> rs.getString("name") }.list()
            for (column in listOf("input_tokens", "output_tokens", "requests")) {
                if (column in ledgerColumns) continue
                addColumn("usage_ledger", column, "INTEGER NOT NULL DEFAULT 0")
                jdbc.sql("UPDATE usage_ledger SET $column = COALESCE((SELECT $column FROM analysis_task WHERE task_id = usage_ledger.task_id), 0)").update()
            }
            jdbc.sql("CREATE INDEX IF NOT EXISTS idx_books_source_version ON books(source_ref, import_version)").update()
        }
    }

    private fun addColumn(
        table: String,
        column: String,
        definition: String,
    ) {
        val columns = jdbc.sql("PRAGMA table_info($table)").query { rs, _ -> rs.getString("name") }.list()
        if (column !in columns) jdbc.sql("ALTER TABLE $table ADD COLUMN $column $definition").update()
    }
}
