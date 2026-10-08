// 评测运行记录的文件存储：每次运行一个目录 runs/<评测集>/<运行 ID>/report.json，只存文件不入库。
package com.zhiying.infrastructure.evaluation

import com.zhiying.application.evaluation.EvaluationRun
import com.zhiying.application.evaluation.EvaluationRunStore
import com.zhiying.application.evaluation.EvaluationRunSummary
import com.zhiying.infrastructure.config.ZhiYingProperties
import org.slf4j.LoggerFactory
import org.springframework.stereotype.Component
import tools.jackson.databind.DeserializationFeature
import tools.jackson.databind.PropertyNamingStrategies
import tools.jackson.databind.SerializationFeature
import tools.jackson.databind.json.JsonMapper
import tools.jackson.module.kotlin.jacksonMapperBuilder
import tools.jackson.module.kotlin.readValue
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import kotlin.io.path.isDirectory
import kotlin.io.path.listDirectoryEntries
import kotlin.io.path.name

/** 评测文件共用的 JSON 映射：字段 snake_case，忽略多余字段，输出缩进便于直接阅读。 */
internal object EvalJson {
    val mapper: JsonMapper = jacksonMapperBuilder()
        .propertyNamingStrategy(PropertyNamingStrategies.SNAKE_CASE)
        .disable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
        .enable(SerializationFeature.INDENT_OUTPUT)
        .build()
}

/** 文件实现的运行记录存储。 */
@Component
class FileEvaluationRunStore(properties: ZhiYingProperties) : EvaluationRunStore {
    private val log = LoggerFactory.getLogger(javaClass)
    private val root: Path = properties.eval.path.resolve("runs")

    /** 先写临时文件再改名，避免留下写了一半的报告。 */
    override fun save(run: EvaluationRun) {
        val dir = root.resolve(run.suite).resolve(run.id)
        Files.createDirectories(dir)
        val temp = Files.createTempFile(dir, "report-", ".tmp")
        EvalJson.mapper.writeValue(temp.toFile(), run)
        Files.move(temp, dir.resolve(REPORT_FILE), StandardCopyOption.REPLACE_EXISTING)
    }

    /** 读不出来的旧记录（格式已变）跳过并记日志，不影响列出其余记录。 */
    override fun list(suite: String): List<EvaluationRunSummary> {
        val dir = root.resolve(suite)
        if (!dir.isDirectory()) return emptyList()
        return dir.listDirectoryEntries().map { it.name }.sortedDescending().mapNotNull { id ->
            runCatching { find(suite, id)?.summary() }
                .onFailure { log.warn("跳过读不出的评测运行记录 {}/{}：{}", suite, id, it.message) }
                .getOrNull()
        }
    }

    override fun find(suite: String, id: String): EvaluationRun? {
        val file = root.resolve(suite).resolve(id).resolve(REPORT_FILE).normalize()
        if (!file.startsWith(root.normalize()) || !Files.exists(file)) return null
        return EvalJson.mapper.readValue<EvaluationRun>(file.toFile())
    }

    private companion object {
        const val REPORT_FILE = "report.json"
    }
}
