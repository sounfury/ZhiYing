// 表结构兼容迁移：补账号额度、版本与 TXT 分章列、迁移模型设置，并将旧书主迁为同 ID 条目。
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
            for (table in listOf("accounts", "invitations")) {
                // 补列不带 CHECK：SQLite 会为它扫描旧行，驱动报 Query returns results；非负由应用层校验
                addColumn(table, "max_books", "INTEGER")
                addColumn(table, "max_tokens", "INTEGER")
            }
            addColumn("books", "import_version", "INTEGER NOT NULL DEFAULT 1")
            addColumn("books", "split_rule", "TEXT")
            migrateModelSettings()
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
                jdbc
                    .sql(
                        "UPDATE usage_ledger SET $column = COALESCE((SELECT $column FROM analysis_task WHERE task_id = usage_ledger.task_id), 0)",
                    ).update()
            }
            jdbc.sql("CREATE INDEX IF NOT EXISTS idx_books_source_version ON books(source_ref, import_version)").update()
        }
    }

    private fun migrateModelSettings() {
        val exists =
            jdbc
                .sql("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'model_settings'")
                .query(Int::class.java)
                .single() > 0
        if (!exists) return
        addColumn("model_settings", "provider_id", "TEXT NOT NULL DEFAULT 'default'")
        jdbc
            .sql(
                """INSERT OR IGNORE INTO app_settings (setting_group, setting_key, value_json, updated_at, updated_by)
            SELECT 'model', call_point,
                json_object('providerId', provider_id, 'model', model, 'thinking', json(CASE WHEN thinking = 1 THEN 'true' ELSE 'false' END)),
                updated_at, updated_by
            FROM model_settings WHERE provider_id <> 'default'""",
            ).update()
        jdbc.sql("DROP TABLE model_settings").update()
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
