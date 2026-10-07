// 模型调用的任务级控制与统计：预算、取消信号、用量；由应用层创建并在同一任务的多次调用间共享。
package com.zhiying.application.llm

import com.zhiying.application.diagnostics.TokenUsage
import java.util.concurrent.atomic.AtomicLong

/** 取消信号：返回 true 表示任务已被取消，执行器不得再发出新请求。 */
fun interface CancelSignal {
    /** 是否已取消。 */
    fun isCancelled(): Boolean

    companion object {
        /** 永不取消。 */
        val NEVER = CancelSignal { false }
    }
}

/**
 * 请求数与 token 预算，线程安全，可由同一任务的多章、多调用点共享。
 *
 * 预算耗尽是执行结果，不等于任何语义结论。
 * 入参：[maxRequests] 请求数上限，[maxTokens] 总 token 上限，0 表示不限；
 * [parent] 上级预算（如单章预算挂在整任务预算下），本级与上级都有余量才放行，消耗同时记入两级。
 */
class ModelCallBudget(
    private val maxRequests: Long = 0,
    private val maxTokens: Long = 0,
    private val parent: ModelCallBudget? = null,
) {
    private val requests = AtomicLong()
    private val tokens = AtomicLong()
    private val inputs = AtomicLong()
    private val outputs = AtomicLong()

    /** 预留一次请求名额；本级或上级预算已耗尽时返回 false，且不计数。 */
    fun tryReserve(): Boolean {
        if (maxTokens > 0 && tokens.get() >= maxTokens) return false
        val used = requests.incrementAndGet()
        if ((maxRequests > 0 && used > maxRequests) || parent?.tryReserve() == false) {
            requests.decrementAndGet()
            return false
        }
        return true
    }

    /** 记录一次请求消耗的输入 / 输出 / 总 token（同时记入上级）。 */
    fun recordTokens(usage: TokenUsage) {
        tokens.addAndGet(usage.total.toLong())
        inputs.addAndGet(usage.input.toLong())
        outputs.addAndGet(usage.output.toLong())
        parent?.recordTokens(usage)
    }

    /** 已预留的请求数。 */
    val usedRequests: Long get() = requests.get()

    /** 已消耗的输入 token 数。 */
    val usedInputTokens: Long get() = inputs.get()

    /** 已消耗的输出 token 数。 */
    val usedOutputTokens: Long get() = outputs.get()

    /** 已消耗的 token 数。 */
    val usedTokens: Long get() = tokens.get()
}

/** 一次调用（或一组调用）所受的任务级控制：共享预算与取消信号，默认不限、不取消。 */
data class ModelCallControl(
    val budget: ModelCallBudget = ModelCallBudget(),
    val cancel: CancelSignal = CancelSignal.NEVER,
)

/**
 * 一次执行的统计：实际发出的请求数（含重试）、token 用量与总耗时。
 *
 * 失败或重试的请求同样计入，便于核对真实花费。
 */
data class ModelCallStats(
    val requests: Int = 0,
    val usage: TokenUsage = TokenUsage(0, 0, 0),
    val elapsedMillis: Long = 0,
) {
    /** 合并两份统计。 */
    operator fun plus(other: ModelCallStats) = ModelCallStats(
        requests + other.requests,
        TokenUsage(
            usage.input + other.usage.input,
            usage.output + other.usage.output,
            usage.total + other.usage.total,
        ),
        elapsedMillis + other.elapsedMillis,
    )
}
