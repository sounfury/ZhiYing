// 评测用例（DESIGN §7.2）：准备（导入或清空）并发起整书分析；给当前已发布结果评分并保存运行记录；查询评测集与运行记录。
package com.zhiying.application.evaluation

import com.zhiying.application.analyze.run.AnalysisRunner
import com.zhiying.application.analyze.run.AnalysisTask
import com.zhiying.application.analyze.run.AnalysisTaskStore
import com.zhiying.application.analyze.run.TaskUsage
import com.zhiying.application.error.AppException
import com.zhiying.application.error.ErrorCode
import com.zhiying.application.graphquery.RevisionStore
import com.zhiying.application.importbook.ImportBook
import com.zhiying.application.library.LibraryQueries
import com.zhiying.application.removal.BookRemoval
import com.zhiying.domain.evaluation.EvaluationReport
import com.zhiying.domain.evaluation.EvaluationScorer
import com.zhiying.domain.evaluation.GoldSuite
import com.zhiying.domain.library.BookId
import org.springframework.stereotype.Service
import java.time.Duration
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/** 评测集的源电子书。 */
class SuiteSource(val fileName: String, val content: ByteArray)

/** 评测集存储：按评测集名读标准标注与源文件。评测集不存在抛 NOT_FOUND，标注格式错误抛 INVALID_ARGUMENT。 */
interface EvaluationSuiteStore {
    /** 全部评测集名。 */
    fun names(): List<String>

    /** 读取评测集。 */
    fun load(name: String): GoldSuite

    /** 读取评测集的源电子书。 */
    fun source(name: String): SuiteSource
}

/**
 * 一次评测的运行记录。
 *
 * 入参：[model] 读章所用模型；[taskKind]、[usage]、[durationSeconds] 产生所评结果的那次分析任务的类型、用量与耗时，
 * 找不到对应任务时为 null。
 */
data class EvaluationRun(
    val id: String,
    val suite: String,
    val bookId: String,
    val revisionId: String,
    val createdAt: Instant,
    val model: String,
    val taskKind: String?,
    val usage: TaskUsage?,
    val durationSeconds: Long?,
    val report: EvaluationReport,
) {
    /** 列表用的摘要。 */
    fun summary() = EvaluationRunSummary(id, createdAt, model, report.score, taskKind, usage?.totalTokens, durationSeconds)
}

/** 运行记录摘要。 */
data class EvaluationRunSummary(
    val id: String,
    val createdAt: Instant,
    val model: String,
    val score: Double,
    val taskKind: String?,
    val totalTokens: Long?,
    val durationSeconds: Long?,
)

/** 运行记录存储：只存文件，不入库。 */
interface EvaluationRunStore {
    fun save(run: EvaluationRun)

    /** 某评测集的全部运行摘要，新的在前。 */
    fun list(suite: String): List<EvaluationRunSummary>

    fun find(suite: String, id: String): EvaluationRun?
}

/** 评测用到的运行环境信息（由基础设施从配置装配）：[model] 读章所用模型名。 */
data class EvaluationSettings(val model: String)

/** 评测集概要；[bookId] 为书库里对应的书，未导入为 null；[error] 标注读取失败的原因。 */
data class SuiteOverview(
    val name: String,
    val book: String?,
    val chapterCount: Int?,
    val bookId: String?,
    val lastRun: EvaluationRunSummary?,
    val error: String? = null,
)

/** 准备结果：评测用的书与刚发起的整书分析任务；[imported] 表示这次从源文件新导入。 */
data class PreparedEvaluation(val bookId: BookId, val task: AnalysisTask, val imported: Boolean)

/** 评测编排。 */
@Service
class Evaluations(
    private val suites: EvaluationSuiteStore,
    private val runs: EvaluationRunStore,
    private val library: LibraryQueries,
    private val importBook: ImportBook,
    private val removal: BookRemoval,
    private val runner: AnalysisRunner,
    private val revisions: RevisionStore,
    private val tasks: AnalysisTaskStore,
    private val settings: EvaluationSettings,
) {

    /** 列出评测集；某个评测集标注读不出来时照常列出并附原因。 */
    fun listSuites(): List<SuiteOverview> = suites.names().map { name ->
        try {
            val suite = suites.load(name)
            SuiteOverview(name, suite.book, suite.chapterCount, findBook(suite)?.value, runs.list(name).firstOrNull())
        } catch (e: AppException) {
            SuiteOverview(name, null, null, null, null, e.message)
        }
    }

    /**
     * 准备并发起整书分析：书库里没有这本书就从源文件导入，已有则清空分析；随后全部章重读。
     * 该书正在分析时抛 ANALYSIS_ALREADY_RUNNING。分析进度沿用普通的分析进度推送，完成后由调用方发起评分。
     */
    fun prepare(name: String): PreparedEvaluation {
        val suite = suites.load(name)
        val existing = findBook(suite)
        val bookId = existing ?: suites.source(name).let { importBook.import(it.fileName, it.content).book.id }
        if (existing != null) removal.clearAnalysis(bookId)
        val task = runner.startFull(bookId, toChapter = null, force = true)
        return PreparedEvaluation(bookId, task, imported = existing == null)
    }

    /**
     * 给该书当前已发布的结果评分并保存运行记录。不调用模型。
     * 书未导入或尚无结果抛 NOT_FOUND，正在分析抛 ANALYSIS_ALREADY_RUNNING。
     */
    fun score(name: String): EvaluationRun {
        val suite = suites.load(name)
        val bookId = findBook(suite) ?: throw AppException(ErrorCode.NOT_FOUND, "书库里没有《${suite.book}》，请先重新分析并评测")
        if (runner.activeTask(bookId) != null) throw AppException(ErrorCode.ANALYSIS_ALREADY_RUNNING, "该书正在分析，完成后再评测")
        val revision = revisions.findPublished(bookId) ?: throw AppException(ErrorCode.NOT_FOUND, "《${suite.book}》还没有分析结果")
        val chapters = library.listAnalyzableChapters(bookId).sortedBy { it.order }.map { library.readChapter(it.id) }
        val report = EvaluationScorer.score(suite, revision, chapters)
        val task = tasks.latest(bookId)?.takeIf { it.revisionId == revision.id }
        val now = Instant.now()
        val run = EvaluationRun(
            id = RUN_ID.format(now),
            suite = name,
            bookId = bookId.value,
            revisionId = revision.id.value,
            createdAt = now,
            model = settings.model,
            taskKind = task?.kind?.name,
            usage = task?.usage,
            durationSeconds = task?.finishedAt?.let { Duration.between(task.startedAt, it).seconds },
            report = report,
        )
        runs.save(run)
        return run
    }

    fun listRuns(name: String): List<EvaluationRunSummary> = runs.list(name)

    fun getRun(name: String, id: String): EvaluationRun =
        runs.find(name, id) ?: throw AppException(ErrorCode.NOT_FOUND, "运行记录不存在：$name/$id")

    /** 按书名与正文章数在书库里认书；有多本时取最近导入的。 */
    private fun findBook(suite: GoldSuite): BookId? = library.listBooks()
        .filter { it.book.title == suite.book && it.profile.analysisChapters == suite.chapterCount }
        .maxByOrNull { it.importedAt }?.book?.id

    private companion object {
        /** 运行记录 ID：本地时间到秒。 */
        val RUN_ID: DateTimeFormatter = DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss").withZone(ZoneId.systemDefault())
    }
}
