// 评测集文件读取：从评测目录读 suite.json 与逐章 chapter_NNN.json，转成领域的标准标注；源电子书路径相对评测集目录。
package com.zhiying.infrastructure.evaluation

import com.zhiying.application.error.AppException
import com.zhiying.application.error.ErrorCode
import com.zhiying.application.evaluation.EvaluationSuiteStore
import com.zhiying.application.evaluation.SuiteSource
import com.zhiying.domain.evaluation.GoldChapter
import com.zhiying.domain.evaluation.GoldForbidden
import com.zhiying.domain.evaluation.GoldPerson
import com.zhiying.domain.evaluation.GoldRelation
import com.zhiying.domain.evaluation.GoldSuite
import com.zhiying.domain.evaluation.Tier
import com.zhiying.domain.evaluation.TypeCriteria
import com.zhiying.infrastructure.config.ZhiYingProperties
import org.springframework.stereotype.Component
import tools.jackson.module.kotlin.readValue
import java.nio.file.Files
import java.nio.file.Path
import kotlin.io.path.isDirectory
import kotlin.io.path.listDirectoryEntries
import kotlin.io.path.name

/** 按目录实现的评测集存储；每次读取都重新读文件，改标注不用重启。 */
@Component
class FileEvaluationSuiteStore(properties: ZhiYingProperties) : EvaluationSuiteStore {
    private val root: Path = properties.eval.path

    override fun names(): List<String> =
        if (!root.isDirectory()) emptyList()
        else root.listDirectoryEntries().filter { Files.exists(it.resolve(SUITE_FILE)) }.map { it.name }.sorted()

    override fun load(name: String): GoldSuite {
        val dir = suiteDir(name)
        return parse(name) {
            val suite = EvalJson.mapper.readValue<SuiteFile>(dir.resolve(SUITE_FILE).toFile())
            val chapters = (1..suite.chapters).mapNotNull { n ->
                dir.resolve("chapter_%03d.json".format(n)).takeIf { Files.exists(it) }
                    ?.let { EvalJson.mapper.readValue<ChapterFile>(it.toFile()).toDomain() }
            }
            GoldSuite(name, suite.book, suite.chapters, suite.cast.map { GoldPerson(it.name, it.aliases) }, chapters)
        }
    }

    override fun source(name: String): SuiteSource {
        val suite = parse(name) { EvalJson.mapper.readValue<SuiteFile>(suiteDir(name).resolve(SUITE_FILE).toFile()) }
        val file = suiteDir(name).resolve(suite.sourceEpub).normalize()
        if (!Files.exists(file)) throw AppException(ErrorCode.NOT_FOUND, "评测集 $name 的源文件不存在：$file")
        return SuiteSource(file.name, Files.readAllBytes(file))
    }

    /** 评测集目录；名字只能是目录名，不允许跳出评测目录。 */
    private fun suiteDir(name: String): Path {
        val dir = root.resolve(name).normalize()
        if (dir.parent != root.normalize() || !Files.exists(dir.resolve(SUITE_FILE))) {
            throw AppException(ErrorCode.NOT_FOUND, "评测集不存在：$name")
        }
        return dir
    }

    /** 文件格式或标注内容不合法时统一报 INVALID_ARGUMENT，附具体原因。 */
    private fun <T> parse(name: String, block: () -> T): T = try {
        block()
    } catch (e: AppException) {
        throw e
    } catch (e: Exception) {
        throw AppException(ErrorCode.INVALID_ARGUMENT, "评测集 $name 标注读取失败：${e.message}")
    }

    private companion object {
        const val SUITE_FILE = "suite.json"
    }
}

// ── 文件格式（schema 2.0，字段 snake_case；人物出场、身份断言等字段只供人工阅读，读取时忽略） ──

private data class SuiteFile(val book: String, val sourceEpub: String, val chapters: Int, val cast: List<CastFile>)

private data class CastFile(val name: String, val aliases: List<String> = emptyList())

private data class QuoteFile(val quote: String)

private data class RelationFile(
    val personA: String,
    val personB: String,
    val label: String,
    val types: Set<String> = emptySet(),
    val keywords: List<String> = emptyList(),
    val source: String? = null,
    val evidence: List<QuoteFile> = emptyList(),
    val note: String? = null,
    /** 分档 hard / medium / soft，不写时按可接受类型推断 */
    val tier: String? = null,
) {
    fun toDomain() = GoldRelation(
        personA, personB, label, TypeCriteria(types, keywords), source, evidence.map { it.quote }, note,
        tier?.let { Tier.valueOf(it.uppercase()) },
    )
}

private data class ForbiddenFile(
    val personA: String,
    val personB: String,
    val types: Set<String> = emptySet(),
    val keywords: List<String> = emptyList(),
    val reason: String,
    val evidence: List<QuoteFile> = emptyList(),
) {
    fun toDomain() = GoldForbidden(personA, personB, TypeCriteria(types, keywords), reason, evidence.map { it.quote })
}

private data class ChapterFile(
    val chapter: Int,
    val title: String,
    val requiredRelations: List<RelationFile> = emptyList(),
    val optionalRelations: List<RelationFile> = emptyList(),
    val forbiddenRelations: List<ForbiddenFile> = emptyList(),
) {
    fun toDomain() = GoldChapter(
        chapter, title,
        requiredRelations.map { it.toDomain() },
        optionalRelations.map { it.toDomain() },
        forbiddenRelations.map { it.toDomain() },
    )
}
