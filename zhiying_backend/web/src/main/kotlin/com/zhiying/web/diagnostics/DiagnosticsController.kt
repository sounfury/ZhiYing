package com.zhiying.web.diagnostics

import com.zhiying.application.diagnostics.CheckOutcome
import com.zhiying.application.diagnostics.CheckResult
import com.zhiying.application.diagnostics.ModelDiagnostics
import com.zhiying.application.diagnostics.ModelProbeReport
import com.zhiying.application.diagnostics.ThinkingMode
import com.zhiying.application.diagnostics.TokenUsage
import com.zhiying.application.error.AppException
import com.zhiying.application.error.ErrorCode
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController

/** 诊断接口：供开发与部署时确认外部依赖可用。 */
@RestController
@RequestMapping("/api/diagnostics")
class DiagnosticsController(private val diagnostics: ModelDiagnostics) {

    /**
     * 探测模型接入：依次检查对话、工具调用与结构化输出，每项都会真实调用模型并产生费用。
     * 全部通过返回 200；任一项失败返回 502，响应体同样是完整报告；thinking 取值非法时返回 INVALID_ARGUMENT。
     */
    @GetMapping("/model")
    fun probeModel(@RequestParam(defaultValue = "default") thinking: String): ResponseEntity<ModelProbeResponse> {
        val mode = ThinkingMode.entries.firstOrNull { it.name.equals(thinking, ignoreCase = true) }
            ?: throw AppException(ErrorCode.INVALID_ARGUMENT, "thinking 只能是 default、enabled 或 disabled")
        val report = diagnostics.run(mode)
        val status = if (report.passed) HttpStatus.OK else HttpStatus.BAD_GATEWAY
        return ResponseEntity.status(status).body(ModelProbeResponse.from(report))
    }
}

/** 模型探测报告的 HTTP 表示。 */
data class ModelProbeResponse(
    val passed: Boolean,
    val baseUrl: String,
    val model: String,
    val thinking: String,
    val checks: List<CheckResponse>,
) {
    companion object {
        /** 由应用层报告转换。 */
        fun from(report: ModelProbeReport) = ModelProbeResponse(
            passed = report.passed,
            baseUrl = report.target.baseUrl,
            model = report.target.model,
            thinking = report.thinking.name.lowercase(),
            checks = report.results.map(CheckResponse::from),
        )
    }
}

/** 单项检查的 HTTP 表示；失败时 [failure] 给出执行失败类别，[detail] 为原始信息。 */
data class CheckResponse(
    val check: String,
    val passed: Boolean,
    val elapsedMs: Long,
    val detail: String,
    val failure: String?,
    val usage: TokenUsage?,
) {
    companion object {
        /** 由单项检查结果转换。 */
        fun from(result: CheckResult): CheckResponse {
            val name = result.check.name.lowercase()
            val elapsedMs = result.elapsed.inWholeMilliseconds
            return when (val outcome = result.outcome) {
                is CheckOutcome.Passed -> CheckResponse(name, true, elapsedMs, outcome.detail, null, outcome.usage)
                is CheckOutcome.Failed ->
                    CheckResponse(name, false, elapsedMs, outcome.message, outcome.failure.name.lowercase(), null)
            }
        }
    }
}
