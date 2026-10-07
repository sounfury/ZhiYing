// 单次模型请求的统一执行入口：并发限制、预算与取消检查、按执行政策重试、用量与耗时统计、失败归类。
// 工具循环执行器与结构化调用执行器都经由它发请求；它不理解业务，也不决定重试之外的任何流程。
package com.zhiying.infrastructure.llm

import com.zhiying.application.diagnostics.ModelFailure
import com.zhiying.application.diagnostics.TokenUsage
import com.zhiying.application.llm.ModelCallControl
import com.zhiying.application.llm.ModelCallStats
import com.zhiying.infrastructure.config.ZhiYingProperties
import org.springframework.ai.chat.messages.Message
import org.springframework.ai.chat.model.ChatModel
import org.springframework.ai.chat.model.ChatResponse
import org.springframework.ai.chat.prompt.Prompt
import org.springframework.ai.openai.OpenAiChatOptions
import org.springframework.ai.tool.ToolCallback
import org.springframework.stereotype.Component
import java.util.concurrent.Semaphore

/**
 * 单次请求的差异化设置。
 *
 * 入参：[model] 模型名，null 用默认模型；[thinking] 是否开启 DeepSeek 思考模式；[tools] 本次请求携带的工具定义。
 */
data class CallSpec(
    val model: String? = null,
    val thinking: Boolean = false,
    val tools: List<ToolCallback> = emptyList(),
)

/** 一次执行内的累计统计器；同一次执行中的多次请求（含重试）都累加到这里。非线程安全，一次执行一个。 */
class CallMeter {
    private val startedNanos = System.nanoTime()
    private var requests = 0
    private var input = 0
    private var output = 0
    private var total = 0

    /** 记录发出了一次请求。 */
    fun requestSent() {
        requests++
    }

    /** 累加一次响应的 token 用量。 */
    fun addUsage(usage: TokenUsage) {
        input += usage.input
        output += usage.output
        total += usage.total
    }

    /** 当前累计统计，耗时从统计器创建时起算。 */
    fun stats() = ModelCallStats(
        requests,
        TokenUsage(input, output, total),
        (System.nanoTime() - startedNanos) / NANOS_PER_MILLI,
    )

    private companion object {
        const val NANOS_PER_MILLI = 1_000_000
    }
}

/** 单次请求（含其重试）的结果。 */
sealed interface InvokeResult {
    /** 取得回复。 */
    data class Reply(val response: ChatResponse) : InvokeResult

    /** 执行失败；不等于任何语义结论。 */
    data class Failed(val failure: ModelFailure, val message: String) : InvokeResult
}

/**
 * 模型请求执行器。
 *
 * SDK 的 max-retries 已设为 0，限流、超时、网络与服务端错误的重试只在这里按 `zhiying.model-call.*` 发生；
 * 鉴权、余额不足、参数被拒不重试。全局并发由信号量限制，预算与取消在每次请求前检查。
 */
@Component
class ModelInvoker(
    private val chatModel: ChatModel,
    private val properties: ZhiYingProperties,
) {
    private val policy = properties.modelCall
    private val permits = Semaphore(policy.maxConcurrentRequests)

    /** 默认模型名，用于记录抽取所用模型。 */
    fun defaultModel(): String = properties.llm.model

    /**
     * 发出一次请求并按政策重试。
     *
     * 入参：[messages] 完整消息序列；[spec] 本次请求设置；[control] 任务级预算与取消；[meter] 累计统计器。
     * 出参：[InvokeResult.Reply] 或带失败类别的 [InvokeResult.Failed]，不抛出模型调用异常。
     */
    fun invoke(messages: List<Message>, spec: CallSpec, control: ModelCallControl, meter: CallMeter): InvokeResult {
        val prompt = Prompt(messages, optionsOf(spec))
        var retries = 0
        while (true) {
            // 流程：取消检查 → 预算预留 → 带并发许可发请求 → 成功则记用量返回；可重试失败则退避后再来
            if (control.cancel.isCancelled()) return InvokeResult.Failed(ModelFailure.CANCELLED, "任务已取消")
            if (!control.budget.tryReserve()) {
                return InvokeResult.Failed(ModelFailure.BUDGET_EXHAUSTED, "请求数或 token 预算已耗尽")
            }
            meter.requestSent()
            val attempt = attemptOnce(prompt)
            if (attempt is Attempt.Ok) {
                val usage = usageOf(attempt.response)
                meter.addUsage(usage)
                control.budget.recordTokens(usage)
                return InvokeResult.Reply(attempt.response)
            }
            val failed = attempt as Attempt.Err
            if (failed.failure !in RETRYABLE || retries >= policy.maxRetries) {
                return InvokeResult.Failed(failed.failure, failed.message)
            }
            retries++
            if (!sleepBackoff(retries)) return InvokeResult.Failed(ModelFailure.CANCELLED, "重试等待期间被中断")
        }
    }

    /** 在并发许可内发一次请求，异常归类后返回，不外抛。 */
    private fun attemptOnce(prompt: Prompt): Attempt {
        try {
            permits.acquire()
        } catch (e: InterruptedException) {
            Thread.currentThread().interrupt()
            return Attempt.Err(ModelFailure.CANCELLED, "等待并发许可时被中断")
        }
        return try {
            Attempt.Ok(chatModel.call(prompt))
        } catch (e: Exception) {
            Attempt.Err(classifyFailure(e), e.message ?: e.javaClass.name)
        } finally {
            permits.release()
        }
    }

    /** 指数退避等待；被中断返回 false。 */
    private fun sleepBackoff(retries: Int): Boolean {
        val base = policy.retryBaseDelay.toMillis()
        val delay = minOf(base shl (retries - 1).coerceAtMost(MAX_SHIFT), policy.retryMaxDelay.toMillis())
        return try {
            Thread.sleep(delay)
            true
        } catch (e: InterruptedException) {
            Thread.currentThread().interrupt()
            false
        }
    }

    /** 由请求设置构造选项：显式写入思考开关，覆盖全局默认；携带工具定义，工具由调用方自己执行。 */
    private fun optionsOf(spec: CallSpec): OpenAiChatOptions {
        // 构建器自带默认模型名，会盖掉全局配置，所以模型名必须显式给出
        val builder = OpenAiChatOptions.builder()
            .model(spec.model?.takeIf { it.isNotBlank() } ?: properties.llm.model)
            .temperature(policy.temperature)
            .timeout(policy.timeout)
            .extraBody(mapOf("thinking" to mapOf("type" to if (spec.thinking) "enabled" else "disabled")))
        if (spec.tools.isNotEmpty()) builder.toolCallbacks(spec.tools)
        return builder.build()
    }

    /** 读取响应的 token 用量；供应商没返回时记为 0。 */
    private fun usageOf(response: ChatResponse): TokenUsage =
        response.metadata.usage.let { TokenUsage(it.promptTokens ?: 0, it.completionTokens ?: 0, it.totalTokens ?: 0) }

    private sealed interface Attempt {
        data class Ok(val response: ChatResponse) : Attempt
        data class Err(val failure: ModelFailure, val message: String) : Attempt
    }

    private companion object {
        /** 可重试的瞬时失败。 */
        val RETRYABLE = setOf(
            ModelFailure.RATE_LIMITED,
            ModelFailure.TIMEOUT,
            ModelFailure.NETWORK,
            ModelFailure.PROVIDER_ERROR,
        )

        /** 退避位移上限，防止溢出。 */
        const val MAX_SHIFT = 20
    }
}
