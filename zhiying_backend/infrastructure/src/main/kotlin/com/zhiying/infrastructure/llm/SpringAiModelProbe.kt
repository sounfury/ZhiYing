// 模型协议探针：使用指定服务商的连接和模型，不把连接地址与密钥返回后台。
package com.zhiying.infrastructure.llm

import com.zhiying.application.diagnostics.CheckOutcome
import com.zhiying.application.diagnostics.ModelFailure
import com.zhiying.application.diagnostics.ModelProbe
import com.zhiying.application.diagnostics.ModelTarget
import com.zhiying.application.diagnostics.ProbeCheck
import com.zhiying.application.diagnostics.ThinkingMode
import com.zhiying.application.diagnostics.TokenUsage
import org.springframework.ai.chat.model.ChatResponse
import org.springframework.ai.chat.prompt.Prompt
import org.springframework.ai.converter.BeanOutputConverter
import org.springframework.ai.model.tool.ToolCallingManager
import org.springframework.ai.openai.OpenAiChatOptions
import org.springframework.ai.support.ToolCallbacks
import org.springframework.ai.tool.ToolCallback
import org.springframework.ai.tool.annotation.Tool
import org.springframework.stereotype.Component
import java.util.UUID
import java.util.concurrent.atomic.AtomicInteger

/**
 * 基于 Spring AI OpenAI 兼容协议的模型探针。
 *
 * 每项检查只验证一种协议能力，结果只看回复是否符合预期，不做任何业务判断。
 */
@Component
class SpringAiModelProbe(
    private val providers: ProviderChatModels,
) : ModelProbe {
    /** 当前探测目标。 */
    override fun target(
        provider: String,
        model: String,
    ) = ModelTarget(provider, model)

    /** 执行一项检查；任何调用异常都归类为执行失败，不向上抛出。 */
    override fun run(
        check: ProbeCheck,
        thinking: ThinkingMode,
        provider: String,
        model: String,
    ): CheckOutcome =
        try {
            val target = Target(providers.of(provider), thinking, model)
            when (check) {
                ProbeCheck.CHAT -> chat(target)
                ProbeCheck.TOOL_CALL -> toolCall(target)
                ProbeCheck.STRUCTURED_OUTPUT -> structuredOutput(target)
            }
        } catch (e: Exception) {
            val failure = classifyFailure(e)
            CheckOutcome.Failed(failure, "模型连接检查失败（${failure.name}）")
        }

    /** 普通对话：要求模型原样复述一段随机校验码（与回复语言无关，避免被意译）。 */
    private fun chat(target: Target): CheckOutcome {
        val code = newProbeCode()
        val response = request(target, "原样回复这段校验码，不要添加其他内容：$code")
        val reply = replyOf(response)
        return expect(code in reply, "回复：$reply", response)
    }

    /** 工具调用：模型必须调用校验码工具，并在最终回复中带回工具返回的校验码。 */
    private fun toolCall(target: Target): CheckOutcome {
        val tool = ProbeCodeTool(newProbeCode())
        val response =
            request(
                target,
                "先调用 probe_code 工具取得校验码，然后只回复这个校验码。",
                ToolCallbacks.from(tool).toList(),
            )
        val reply = replyOf(response)
        return expect(tool.calls > 0 && tool.code in reply, "工具调用 ${tool.calls} 次，回复：$reply", response)
    }

    /** 结构化输出：回复必须能解析为指定结构，且计算结果正确。 */
    private fun structuredOutput(target: Target): CheckOutcome {
        val converter = BeanOutputConverter(ArithmeticAnswer::class.java, LlmJson.mapper)
        val response = request(target, "计算 17 加 25，给出结果数字与它的中文读法。\n\n${converter.format}")
        val answer = converter.convert(replyOf(response))
        return expect(answer.sum == 42, "解析结果：$answer", response)
    }

    /** 一次探测的服务商、思考模式与模型。 */
    private class Target(
        val provider: ProviderModel,
        val thinking: ThinkingMode,
        val model: String,
    )

    /** 按服务商写法设置思考参数，执行工具并回传完整消息，再取得最终回复。 */
    private fun request(
        target: Target,
        user: String,
        tools: List<ToolCallback> = emptyList(),
    ): ChatResponse {
        val options = OpenAiChatOptions.builder().model(target.model).toolCallbacks(tools)
        if (target.thinking != ThinkingMode.DEFAULT) {
            options.extraBody(providers.thinkingBody(target.provider.thinkingStyle, target.thinking == ThinkingMode.ENABLED))
        }
        var prompt = Prompt(user, options.build())
        var response = target.provider.chatModel.call(prompt)
        val manager = ToolCallingManager.builder().build()
        while (response.hasToolCalls()) {
            val result = manager.executeToolCalls(prompt, response)
            prompt = Prompt(result.conversationHistory(), prompt.options)
            response = target.provider.chatModel.call(prompt)
        }
        return response
    }

    /** 生成一次探测用的随机校验码。 */
    private fun newProbeCode(): String = UUID.randomUUID().toString().take(8)

    /** 取模型最终回复文本。 */
    private fun replyOf(response: ChatResponse?): String =
        response
            ?.result
            ?.output
            ?.text
            .orEmpty()
            .trim()

    /** 满足预期时记为通过并附用量与是否返回思考内容，否则记为回复不符合预期。 */
    private fun expect(
        satisfied: Boolean,
        detail: String,
        response: ChatResponse?,
    ): CheckOutcome =
        if (satisfied) {
            CheckOutcome.Passed("$detail；${reasoningNote(response)}", usageOf(response))
        } else {
            CheckOutcome.Failed(ModelFailure.UNEXPECTED_REPLY, detail)
        }

    /** 说明回复是否带有思考内容，用于确认思考模式开关是否生效。 */
    private fun reasoningNote(response: ChatResponse?): String {
        val reasoning =
            response
                ?.result
                ?.output
                ?.metadata
                ?.get("reasoningContent")
                ?.toString()
        return if (reasoning.isNullOrBlank()) "无思考内容" else "含思考内容 ${reasoning.length} 字"
    }

    /** 读取本次调用的 token 用量。 */
    private fun usageOf(response: ChatResponse?): TokenUsage? =
        response?.metadata?.usage?.let {
            TokenUsage(it.promptTokens, it.completionTokens, it.totalTokens)
        }
}

/** 探测用工具：返回本次探测生成的校验码，并记录被调用次数。 */
class ProbeCodeTool(
    val code: String,
) {
    private val counter = AtomicInteger()

    /** 已被调用的次数。 */
    val calls: Int get() = counter.get()

    /** 返回本次探测的校验码。 */
    @Tool(name = "probe_code", description = "返回本次连通性探测的校验码")
    fun probeCode(): String {
        counter.incrementAndGet()
        return code
    }
}

/** 结构化输出探测的目标结构。 */
data class ArithmeticAnswer(
    val sum: Int,
    val reading: String,
)
