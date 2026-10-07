// 章抽取存储的 SQLite 实现：抽取整体序列化成带格式版本号的 JSON 存一行，另有"当前抽取"指针表。
package com.zhiying.infrastructure.persistence.analysis

import com.zhiying.application.analyze.run.ExtractionStore
import com.zhiying.application.analyze.run.StoredExtraction
import com.zhiying.application.analyze.run.TaskId
import com.zhiying.domain.extraction.ChapterExtraction
import com.zhiying.domain.extraction.ExtractionId
import com.zhiying.domain.library.BookId
import com.zhiying.domain.library.ChapterId
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.stereotype.Repository
import org.springframework.transaction.support.TransactionTemplate
import tools.jackson.module.kotlin.jacksonObjectMapper
import tools.jackson.module.kotlin.readValue
import java.sql.ResultSet
import java.time.Instant

/**
 * [ExtractionStore] 的 SQLite 实现。
 *
 * 保存是一个短事务：插入不可变的抽取行，并把该章当前指针切到它；模型调用不在事务内。
 */
@Repository
class SqliteExtractionStore(
    private val jdbc: JdbcClient,
    private val transactions: TransactionTemplate,
) : ExtractionStore {

    private val mapper = jacksonObjectMapper()

    private companion object {
        const val SELECT = "SELECT e.task_id, e.warnings, e.payload, e.created_at FROM chapter_extraction e"
    }

    override fun save(bookId: BookId, taskId: TaskId, extraction: ChapterExtraction, warnings: List<String>) {
        val record = extraction.toRecord()
        val payload = mapper.writeValueAsString(record)
        transactions.executeWithoutResult {
            jdbc.sql(
                """INSERT INTO chapter_extraction (extraction_id, book_id, chapter_id, task_id, format_version, text_revision,
                   model, prompt_version, warnings, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            ).params(
                listOf(
                    extraction.id.value, bookId.value, extraction.chapterId.value, taskId.value, EXTRACTION_FORMAT_VERSION,
                    record.textRevision, record.model, record.promptVersion, mapper.writeValueAsString(warnings), payload,
                    Instant.now().toString(),
                ),
            ).update()
            jdbc.sql(
                """INSERT INTO chapter_extraction_current (chapter_id, book_id, extraction_id) VALUES (?, ?, ?)
                   ON CONFLICT(chapter_id) DO UPDATE SET extraction_id = excluded.extraction_id""",
            ).params(extraction.chapterId.value, bookId.value, extraction.id.value).update()
        }
    }

    override fun findCurrent(chapterId: ChapterId): StoredExtraction? =
        jdbc.sql("$SELECT JOIN chapter_extraction_current c ON c.extraction_id = e.extraction_id WHERE c.chapter_id = ?")
            .param(chapterId.value).query { rs, _ -> storedOf(rs) }.optional().orElse(null)

    override fun listCurrent(bookId: BookId): List<StoredExtraction> =
        jdbc.sql("$SELECT JOIN chapter_extraction_current c ON c.extraction_id = e.extraction_id WHERE c.book_id = ?")
            .param(bookId.value).query { rs, _ -> storedOf(rs) }.list()

    override fun find(id: ExtractionId): StoredExtraction? =
        jdbc.sql("$SELECT WHERE e.extraction_id = ?")
            .param(id.value).query { rs, _ -> storedOf(rs) }.optional().orElse(null)

    /** 当前行转已存抽取。 */
    private fun storedOf(rs: ResultSet) = StoredExtraction(
        extraction = mapper.readValue<ExtractionRecord>(rs.getString("payload")).toDomain(),
        taskId = TaskId(rs.getString("task_id")),
        warnings = mapper.readValue<List<String>>(rs.getString("warnings")),
        createdAt = Instant.parse(rs.getString("created_at")),
    )
}
