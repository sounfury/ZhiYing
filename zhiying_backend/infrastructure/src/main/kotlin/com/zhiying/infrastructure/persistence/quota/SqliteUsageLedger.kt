// 用量流水的 SQLite 实现：原子登记任务与字数预占，结束或重启时结算，流水不随书删除。
package com.zhiying.infrastructure.persistence.quota

import com.zhiying.application.analyze.run.AnalysisTask
import com.zhiying.application.analyze.run.AnalysisTaskStore
import com.zhiying.application.analyze.run.TaskId
import com.zhiying.application.quota.UsageLedger
import org.springframework.beans.factory.InitializingBean
import org.springframework.boot.sql.init.dependency.DependsOnDatabaseInitialization
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.stereotype.Repository
import org.springframework.transaction.support.TransactionTemplate
import java.time.Instant

@Repository
@DependsOnDatabaseInitialization
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
    ) {
        transactions.executeWithoutResult {
            tasks.create(task)
            jdbc
                .sql("INSERT INTO usage_ledger (task_id, user_id, item_id, chars, started_at) VALUES (?, ?, ?, ?, ?)")
                .params(task.id.value, userId, task.bookId.value, chars, task.startedAt.toString())
                .update()
        }
    }

    override fun settle(
        taskId: TaskId,
        chars: Long,
        tokens: Long,
    ) {
        jdbc
            .sql("UPDATE usage_ledger SET chars = ?, tokens = ?, settled_at = ? WHERE task_id = ? AND settled_at IS NULL")
            .params(chars, tokens, Instant.now().toString(), taskId.value)
            .update()
    }

    override fun settleInterrupted() {
        jdbc
            .sql(
                """UPDATE usage_ledger SET
               chars = COALESCE((SELECT SUM(c.word_count) FROM analysis_task_chapter tc
                   JOIN chapters c ON c.id = tc.chapter_id
                   WHERE tc.task_id = usage_ledger.task_id AND tc.started_at IS NOT NULL), 0),
               tokens = COALESCE((SELECT total_tokens FROM analysis_task WHERE task_id = usage_ledger.task_id), 0),
               settled_at = ? WHERE settled_at IS NULL""",
            ).param(Instant.now().toString())
            .update()
    }
}
