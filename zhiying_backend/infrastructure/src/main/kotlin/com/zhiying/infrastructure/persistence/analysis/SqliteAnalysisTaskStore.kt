// 分析任务存储的 SQLite 实现：任务行与各章执行行覆盖更新；整书任务同时维护书的分析状态行。
package com.zhiying.infrastructure.persistence.analysis

import com.zhiying.application.analyze.run.AnalysisTask
import com.zhiying.application.analyze.run.AnalysisTaskStore
import com.zhiying.application.analyze.run.BookAnalysisStatus
import com.zhiying.application.analyze.run.ChapterRun
import com.zhiying.application.analyze.run.ChapterRunStatus
import com.zhiying.application.analyze.run.TaskId
import com.zhiying.application.analyze.run.TaskKind
import com.zhiying.application.analyze.run.TaskPhase
import com.zhiying.application.analyze.run.TaskStatus
import com.zhiying.application.analyze.run.TaskUsage
import com.zhiying.domain.library.BookId
import com.zhiying.domain.library.ChapterId
import com.zhiying.domain.revision.RevisionId
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.stereotype.Repository
import org.springframework.transaction.support.TransactionTemplate
import tools.jackson.module.kotlin.jacksonObjectMapper
import tools.jackson.module.kotlin.readValue
import java.sql.ResultSet
import java.time.Instant

/**
 * [AnalysisTaskStore] 的 SQLite 实现。
 *
 * 每次写入是一个短事务；章数很多时进度更新只写变化的那一章，不重写整个任务。
 */
@Repository
class SqliteAnalysisTaskStore(
    private val jdbc: JdbcClient,
    private val transactions: TransactionTemplate,
) : AnalysisTaskStore {

    private val mapper = jacksonObjectMapper()

    override fun create(task: AnalysisTask) {
        transactions.executeWithoutResult {
            jdbc.sql(
                """INSERT INTO analysis_task (task_id, book_id, kind, status, phase, started_at, finished_at, revision_id,
                   message, requests, input_tokens, output_tokens, total_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            ).params(
                listOf(
                    task.id.value, task.bookId.value, task.kind.name, task.status.name, task.phase.name, task.startedAt.toString(),
                    task.finishedAt?.toString(), task.revisionId?.value, task.message, task.usage.requests,
                    task.usage.inputTokens, task.usage.outputTokens, task.usage.totalTokens,
                ),
            ).update()
            task.chapters.forEach { upsertChapter(task.id, it) }
            if (task.kind == TaskKind.FULL) upsertBookStatus(task)
        }
    }

    override fun update(task: AnalysisTask, changed: ChapterRun?) {
        transactions.executeWithoutResult {
            jdbc.sql(
                """UPDATE analysis_task SET status = ?, phase = ?, finished_at = ?, revision_id = ?, message = ?, requests = ?,
                   input_tokens = ?, output_tokens = ?, total_tokens = ? WHERE task_id = ?""",
            ).params(
                listOf(
                    task.status.name, task.phase.name, task.finishedAt?.toString(), task.revisionId?.value, task.message,
                    task.usage.requests, task.usage.inputTokens, task.usage.outputTokens, task.usage.totalTokens, task.id.value,
                ),
            ).update()
            changed?.let { upsertChapter(task.id, it) }
            if (task.kind == TaskKind.FULL) upsertBookStatus(task)
        }
    }

    /** 覆盖写入一章的执行行。 */
    private fun upsertChapter(taskId: TaskId, c: ChapterRun) {
        jdbc.sql(
            """INSERT INTO analysis_task_chapter (task_id, chapter_id, ord, title, status, units_total, units_done, error, warnings)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(task_id, chapter_id) DO UPDATE SET status = excluded.status, units_total = excluded.units_total,
               units_done = excluded.units_done, error = excluded.error, warnings = excluded.warnings""",
        ).params(
            listOf(
                taskId.value, c.chapterId.value, c.order, c.title, c.status.name, c.unitsTotal, c.unitsDone, c.error,
                mapper.writeValueAsString(c.warnings),
            ),
        ).update()
    }

    /** 覆盖写入该书的分析状态（整书任务的最新进展）。 */
    private fun upsertBookStatus(task: AnalysisTask) {
        val status = BookAnalysisStatus.of(task)
        jdbc.sql(
            """INSERT INTO book_analysis (book_id, task_id, status, total_chapters, done_orders, failed_orders, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(book_id) DO UPDATE SET task_id = excluded.task_id, status = excluded.status,
               total_chapters = excluded.total_chapters, done_orders = excluded.done_orders,
               failed_orders = excluded.failed_orders, updated_at = excluded.updated_at""",
        ).params(
            listOf(
                task.bookId.value, task.id.value, status.state.name, status.totalChapters,
                mapper.writeValueAsString(status.chaptersDone), mapper.writeValueAsString(status.chaptersFailed),
                Instant.now().toString(),
            ),
        ).update()
    }

    override fun find(id: TaskId): AnalysisTask? =
        jdbc.sql("SELECT * FROM analysis_task WHERE task_id = ?")
            .param(id.value).query { rs, _ -> taskOf(rs) }.optional().orElse(null)

    override fun latest(bookId: BookId): AnalysisTask? =
        jdbc.sql("SELECT * FROM analysis_task WHERE book_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1")
            .param(bookId.value).query { rs, _ -> taskOf(rs) }.optional().orElse(null)

    override fun bookStatus(bookId: BookId): BookAnalysisStatus =
        jdbc.sql("SELECT * FROM book_analysis WHERE book_id = ?").param(bookId.value).query { rs, _ ->
            BookAnalysisStatus(
                state = BookAnalysisStatus.State.valueOf(rs.getString("status")),
                taskId = TaskId(rs.getString("task_id")),
                totalChapters = rs.getInt("total_chapters"),
                chaptersDone = mapper.readValue<List<Int>>(rs.getString("done_orders")),
                chaptersFailed = mapper.readValue<List<Int>>(rs.getString("failed_orders")),
            )
        }.optional().orElse(BookAnalysisStatus.UPLOADED)

    override fun usageByBook(bookIds: Collection<BookId>): Map<BookId, TaskUsage> {
        if (bookIds.isEmpty()) return emptyMap()
        val sums = jdbc.sql(
            """SELECT book_id, SUM(requests) AS r, SUM(input_tokens) AS i, SUM(output_tokens) AS o, SUM(total_tokens) AS t
               FROM analysis_task WHERE book_id IN (:ids) GROUP BY book_id""",
        ).param("ids", bookIds.map { it.value }).query { rs, _ ->
            BookId(rs.getString("book_id")) to TaskUsage(rs.getLong("r"), rs.getLong("i"), rs.getLong("o"), rs.getLong("t"))
        }.list().toMap()
        return bookIds.associateWith { sums[it] ?: TaskUsage() }
    }

    override fun interruptRunning(reason: String): Int = transactions.execute {
        val now = Instant.now().toString()
        jdbc.sql(
            """UPDATE analysis_task_chapter SET status = 'FAILED', error = ? WHERE status IN ('PENDING', 'RUNNING')
               AND task_id IN (SELECT task_id FROM analysis_task WHERE status = 'RUNNING')""",
        ).param(reason).update()
        jdbc.sql("UPDATE book_analysis SET status = 'FAILED' WHERE status = 'ANALYZING'").update()
        jdbc.sql("UPDATE analysis_task SET status = 'FAILED', phase = 'FINISHED', finished_at = ?, message = ? WHERE status = 'RUNNING'")
            .params(now, reason).update()
    } ?: 0

    /** 当前行转任务快照，并读出各章执行行。 */
    private fun taskOf(rs: ResultSet): AnalysisTask {
        val id = TaskId(rs.getString("task_id"))
        return AnalysisTask(
            id = id,
            bookId = BookId(rs.getString("book_id")),
            kind = TaskKind.valueOf(rs.getString("kind")),
            status = TaskStatus.valueOf(rs.getString("status")),
            phase = TaskPhase.valueOf(rs.getString("phase")),
            startedAt = Instant.parse(rs.getString("started_at")),
            finishedAt = rs.getString("finished_at")?.let { Instant.parse(it) },
            chapters = chaptersOf(id),
            usage = TaskUsage(rs.getLong("requests"), rs.getLong("input_tokens"), rs.getLong("output_tokens"), rs.getLong("total_tokens")),
            revisionId = rs.getString("revision_id")?.let { RevisionId(it) },
            message = rs.getString("message"),
        )
    }

    /** 读出一个任务的全部章执行行（按阅读序号）。 */
    private fun chaptersOf(taskId: TaskId): List<ChapterRun> =
        jdbc.sql("SELECT * FROM analysis_task_chapter WHERE task_id = ? ORDER BY ord").param(taskId.value).query { rs, _ ->
            ChapterRun(
                chapterId = ChapterId(rs.getString("chapter_id")),
                order = rs.getInt("ord"),
                title = rs.getString("title"),
                status = ChapterRunStatus.valueOf(rs.getString("status")),
                unitsTotal = rs.getInt("units_total"),
                unitsDone = rs.getInt("units_done"),
                error = rs.getString("error"),
                warnings = mapper.readValue<List<String>>(rs.getString("warnings")),
            )
        }.list()
}
