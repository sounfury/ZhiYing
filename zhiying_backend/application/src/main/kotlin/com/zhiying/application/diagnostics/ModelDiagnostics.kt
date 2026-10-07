package com.zhiying.application.diagnostics

import org.springframework.stereotype.Service
import kotlin.time.Duration
import kotlin.time.measureTimedValue

/** 单项检查的结果及耗时。 */
data class CheckResult(val check: ProbeCheck, val outcome: CheckOutcome, val elapsed: Duration)

/** 一次完整探测的报告。 */
data class ModelProbeReport(
    val target: ModelTarget,
    val thinking: ThinkingMode,
    val results: List<CheckResult>,
) {
    /** 是否全部检查都通过。 */
    val passed: Boolean get() = results.all { it.outcome is CheckOutcome.Passed }
}

/**
 * 模型接入诊断：按顺序执行全部协议检查并汇总报告。
 *
 * 副作用：每项检查向模型服务发一次真实请求（工具调用检查可能多轮）；某项失败不影响后续检查。
 */
@Service
class ModelDiagnostics(private val probe: ModelProbe) {

    /** 以指定思考模式执行全部检查。 */
    fun run(thinking: ThinkingMode): ModelProbeReport {
        val results = ProbeCheck.entries.map { check ->
            val (outcome, elapsed) = measureTimedValue { probe.run(check, thinking) }
            CheckResult(check, outcome, elapsed)
        }
        return ModelProbeReport(probe.target(), thinking, results)
    }
}
