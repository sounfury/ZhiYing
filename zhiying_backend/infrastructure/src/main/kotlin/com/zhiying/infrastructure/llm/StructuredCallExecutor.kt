// 结构化调用执行器：一次提问、解析回复中的 JSON；供身份歧义、类型归一、补查、兜底、团体归纳等调用点复用。
// 格式说明写在提示里，不强制 tool_choice（DeepSeek 思考模式会拒绝）。预算、重试、用量由 ModelInvoker 负责。
package com.zhiying.infrastructure.llm

import com.zhiying.application.diagnostics.ModelFailure
import com.zhiying.application.llm.ModelCallControl
import com.zhiying.application.llm.ModelCallStats
import com.zhiying.infrastructure.config.ZhiYingProperties
import org.springframework.ai.chat.messages.AssistantMessage
import org.springframework.ai.chat.messages.Message
import org.springframework.ai.chat.messages.SystemMessage
import org.springframework.ai.chat.messages.UserMessage
import org.springframework.ai.converter.BeanOutputConverter
import org.springframework.stereotype.Component

/**
 * 一次结构化调用的请求。
 *
 * 入参：[system]、[user] 提示（格式说明由执行器追加到 system 之后，不必自己写）；[type] 期望的回复结构；
 * [model] 模型名，null 用默认；[thinking] 是否开启思考；[control] 任务级预算与取消；
 * [validate] 业务校验：返回 null 表示通过，返回文字表示不通过，该文字会交还模型要求重答。
 */
class StructuredRequest<T : Any>(
    val system: String,
    val user: String,
    val type: Class<T>,
    val model: String? = null,
    val thinking: Boolean = false,
    val control: ModelCallControl = ModelCallControl(),
    val validate: (T) -> String? = { null },
)

/** 一次结构化调用的结果；无论成败都带统计。 */
sealed interface StructuredOutcome<out T> {
    /** 本次调用的请求数、token 与耗时。 */
    val stats: ModelCallStats

    /** 取得并通过校验的值。 */
    data class Success<T>(val value: T, override val stats: ModelCallStats) : StructuredOutcome<T>

    /** 执行失败，或重答次数用尽后回复仍无法解析 / 校验（此时为 [ModelFailure.UNEXPECTED_REPLY]）。 */
    data class Failed(
        val failure: ModelFailure,
        val message: String,
        override val stats: ModelCallStats,
    ) : StructuredOutcome<Nothing>
}

/**
 * 结构化调用执行器。
 *
 * 回复无法解析或业务校验不通过时，把错误信息作为追加消息要求模型重答，次数受
 * `zhiying.model-call.parse-retries` 限制；重答也走预算与统计。
 */
@Component
class StructuredCallExecutor(
    private val invoker: ModelInvoker,
    private val properties: ZhiYingProperties,
) {
    /**
     * 执行一次结构化调用。
     *
     * 出参：[StructuredOutcome.Success] 或 [StructuredOutcome.Failed]，不抛出模型调用异常。
     */
    fun <T : Any> call(request: StructuredRequest<T>): StructuredOutcome<T> {
        val converter = BeanOutputConverter(request.type, LlmJson.mapper)
        val messages = mutableListOf<Message>(
            SystemMessage(request.system + "\n\n" + converter.format),
            UserMessage(request.user),
        )
        val spec = CallSpec(request.model, request.thinking)
        val meter = CallMeter()
        var lastProblem = ""
        repeat(properties.modelCall.parseRetries + 1) {
            // 流程：发请求 → 解析 JSON → 业务校验；任一步不通过就把原回复与问题追加回去重答
            val reply = when (val result = invoker.invoke(messages, spec, request.control, meter)) {
                is InvokeResult.Failed -> return StructuredOutcome.Failed(result.failure, result.message, meter.stats())
                is InvokeResult.Reply -> result.response.result?.output?.text.orEmpty()
            }
            val parsed = parse(converter, reply)
            val value = parsed.first
            val problem = parsed.second ?: value?.let { request.validate(it) }
            if (value != null && problem == null) return StructuredOutcome.Success(value, meter.stats())
            lastProblem = problem ?: "回复为空"
            messages += AssistantMessage(reply)
            messages += UserMessage("上一条回复有问题：$lastProblem\n请修正后只输出符合格式的 JSON。")
        }
        return StructuredOutcome.Failed(ModelFailure.UNEXPECTED_REPLY, lastProblem, meter.stats())
    }

    /** 解析回复；成功返回 (值, null)，失败返回 (null, 问题说明)。 */
    private fun <T : Any> parse(converter: BeanOutputConverter<T>, reply: String): Pair<T?, String?> =
        try {
            converter.convert(reply) to null
        } catch (e: Exception) {
            null to "无法解析为 JSON：${e.message?.take(PROBLEM_MAX_CHARS)}"
        }

    private companion object {
        const val PROBLEM_MAX_CHARS = 300
    }
}

/** Kotlin 便捷写法：`executor.ask<Dto>(system, user) { 校验 }`。 */
inline fun <reified T : Any> StructuredCallExecutor.ask(
    system: String,
    user: String,
    model: String? = null,
    thinking: Boolean = false,
    control: ModelCallControl = ModelCallControl(),
    noinline validate: (T) -> String? = { null },
): StructuredOutcome<T> = call(StructuredRequest(system, user, T::class.java, model, thinking, control, validate))
