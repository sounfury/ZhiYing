// 用量流水的 SQLite 实现：原子登记任务与字数预占，结束或重启时结算，流水不随书删除。
package com.zhiying.infrastructure.persistence.quota

import com.zhiying.application.analyze.run.AnalysisTask
import com.zhiying.application.analyze.run.AnalysisTaskStore
import com.zhiying.application.analyze.run.TaskId
import com.zhiying.application.analyze.run.TaskUsage
import com.zhiying.domain.library.BookId
import com.zhiying.application.quota.UsageLedger
import org.springframework.beans.factory.InitializingBean
import org.springframework.boot.sql.init.dependency.DependsOnDatabaseInitialization
import org.springframework.context.annotation.DependsOn
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.stereotype.Repository
import org.springframework.transaction.support.TransactionTemplate
import java.time.Instant

@Repository
@DependsOnDatabaseInitialization
@DependsOn("instantReuseMigration")
class SqliteUsageLedger(
    private val jdbc: JdbcClient,
    private val transactions: TransactionTemplate,
    private val tasks: AnalysisTaskStore,
) : UsageLedger,
    InitializingBean {
    override fun afterPropertiesSet() {
        // CREATE IF NOT EXISTS 不会给已有表补列，保留已有书与任务，仅补首次读取标记。
        val columns = jdbc.sql("PRAGMA table_info(analysis_task_chapter)").query { rs, _ -> rs.getString("name") }.list()
        if ("started_at" !in columns) jdbc.sql("ALTER TABLE analysis_task_chapter ADD COLUMN started_at TEXT").update()
    }

    override fun usedChars(userId: String): Long =
        jdbc
            .sql(
                "SELECT COALESCE(SUM(chars), 0) FROM usage_ledger WHERE user_id = ?",
            ).param(userId)
            .query(Long::class.java)
            .single()

    override fun usedTokens(userId: String): Long =
        jdbc
            .sql("SELECT COALESCE(SUM(tokens), 0) FROM usage_ledger WHERE user_id = ?")
            .param(userId)
            .query(Long::class.java)
            .single()

    override fun tokensBetween(
        start: Instant,
        end: Instant,
    ): Long =
        jdbc
            .sql(
                "SELECT COALESCE(SUM(tokens), 0) FROM usage_ledger WHERE unixepoch(started_at) >= unixepoch(?) AND unixepoch(started_at) < unixepoch(?)",
            ).params(start.toString(), end.toString())
            .query(Long::class.java)
            .single()

    override fun reserve(
        task: AnalysisTask,
        userId: String,
        chars: Long,
        itemId: BookId,
    ) {
        transactions.executeWithoutResult {
            tasks.create(task)
            jdbc
                .sql("INSERT INTO usage_ledger (task_id, user_id, item_id, chars, started_at) VALUES (?, ?, ?, ?, ?)")
                .params(task.id.value, userId, itemId.value, chars, task.startedAt.toString())
                .update()
        }
    }

    override fun settle(
        taskId: TaskId,
        chars: Long,
        tokens: Long,
        usage: TaskUsage,
    ) {
        jdbc
            .sql("UPDATE usage_ledger SET chars = ?, tokens = ?, input_tokens = ?, output_tokens = ?, requests = ?, settled_at = ? WHERE task_id = ? AND settled_at IS NULL")
            .params(chars, tokens, usage.inputTokens, usage.outputTokens, usage.requests, Instant.now().toString(), taskId.value)
            .update()
    }

    override fun usageByItem(userId: String, itemIds: Collection<BookId>): Map<BookId, TaskUsage> {
        if (itemIds.isEmpty()) return emptyMap()
        val marks = itemIds.joinToString(",") { "?" }
        val stored = jdbc.sql("""SELECT item_id, SUM(input_tokens) AS inputs, SUM(output_tokens) AS outputs,
            SUM(tokens) AS total, SUM(requests) AS requests FROM usage_ledger
            WHERE user_id = ? AND item_id IN ($marks) GROUP BY item_id""")
            .params(listOf(userId) + itemIds.map { it.value }).query { rs, _ ->
                BookId(rs.getString("item_id")) to TaskUsage(rs.getLong("requests"), rs.getLong("inputs"), rs.getLong("outputs"), rs.getLong("total"))
            }.list().toMap()
        return itemIds.associateWith { stored[it] ?: TaskUsage() }
    }

    override fun settleInterrupted() {
        jdbc
            .sql(
                """UPDATE usage_ledger SET
               chars = COALESCE((SELECT SUM(c.word_count) FROM analysis_task_chapter tc
                   JOIN chapters c ON c.id = tc.chapter_id
                   WHERE tc.task_id = usage_ledger.task_id AND tc.started_at IS NOT NULL), 0),
               tokens = COALESCE((SELECT total_tokens FROM analysis_task WHERE task_id = usage_ledger.task_id), 0),
               input_tokens = COALESCE((SELECT input_tokens FROM analysis_task WHERE task_id = usage_ledger.task_id), 0),
               output_tokens = COALESCE((SELECT output_tokens FROM analysis_task WHERE task_id = usage_ledger.task_id), 0),
               requests = COALESCE((SELECT requests FROM analysis_task WHERE task_id = usage_ledger.task_id), 0),
               settled_at = ? WHERE settled_at IS NULL""",
            ).param(Instant.now().toString())
            .update()
    }
}
