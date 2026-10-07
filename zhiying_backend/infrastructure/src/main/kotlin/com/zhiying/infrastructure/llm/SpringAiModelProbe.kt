package com.zhiying.infrastructure.llm

import com.zhiying.application.diagnostics.CheckOutcome
import com.zhiying.application.diagnostics.ModelFailure
import com.zhiying.application.diagnostics.ModelProbe
import com.zhiying.application.diagnostics.ModelTarget
import com.zhiying.application.diagnostics.ProbeCheck
import com.zhiying.application.diagnostics.ThinkingMode
import com.zhiying.application.diagnostics.TokenUsage
import com.zhiying.infrastructure.config.ZhiYingProperties
import org.springframework.ai.chat.client.ChatClient
import org.springframework.ai.chat.model.ChatResponse
import org.springframework.ai.openai.OpenAiChatOptions
import org.springframework.ai.tool.annotation.Tool
import org.springframework.stereotype.Component
import java.util.UUID
import java.util.concurrent.atomic.AtomicInteger

/**
 * 基于 Spring AI OpenAI 兼容协议的模型探针，当前接入 DeepSeek。
 *
 * 每项检查只验证一种协议能力，结果只看回复是否符合预期，不做任何业务判断。
 */
@Component
class SpringAiModelProbe(
    chatClientBuilder: ChatClient.Builder,
    private val properties: ZhiYingProperties,
) : ModelProbe {

    private val chatClient = chatClientBuilder.build()

    /** 当前探测目标。 */
    override fun target() = ModelTarget(properties.llm.baseUrl, properties.llm.model)

    /** 执行一项检查；任何调用异常都归类为执行失败，不向上抛出。 */
    override fun run(check: ProbeCheck, thinking: ThinkingMode): CheckOutcome = try {
        when (check) {
            ProbeCheck.CHAT -> chat(thinking)
            ProbeCheck.TOOL_CALL -> toolCall(thinking)
            ProbeCheck.STRUCTURED_OUTPUT -> structuredOutput(thinking)
        }
    } catch (e: Exception) {
        CheckOutcome.Failed(classifyFailure(e), e.message ?: e.javaClass.name)
    }

    /** 普通对话：要求模型原样复述一段随机校验码（与回复语言无关，避免被意译）。 */
    private fun chat(thinking: ThinkingMode): CheckOutcome {
        val code = newProbeCode()
        val response = request(thinking).user("原样回复这段校验码，不要添加其他内容：$code").call().chatResponse()
        val reply = replyOf(response)
        return expect(code in reply, "回复：$reply", response)
    }

    /** 工具调用：模型必须调用校验码工具，并在最终回复中带回工具返回的校验码。 */
    private fun toolCall(thinking: ThinkingMode): CheckOutcome {
        val tool = ProbeCodeTool(newProbeCode())
        val response = request(thinking)
            .user("先调用 probe_code 工具取得校验码，然后只回复这个校验码。")
            .tools(tool)
            .call()
            .chatResponse()
        val reply = replyOf(response)
        return expect(tool.calls > 0 && tool.code in reply, "工具调用 ${tool.calls} 次，回复：$reply", response)
    }

    /** 结构化输出：回复必须能解析为指定结构，且计算结果正确。 */
    private fun structuredOutput(thinking: ThinkingMode): CheckOutcome {
        val result = request(thinking)
            .user("计算 17 加 25，给出结果数字与它的中文读法。")
            .call()
            .responseEntity(ArithmeticAnswer::class.java)
        return expect(result.entity?.sum == 42, "解析结果：${result.entity}", result.response)
    }

    /** 按思考模式构造请求；DeepSeek 通过请求体的 thinking 字段开关思考模式。 */
    private fun request(thinking: ThinkingMode): ChatClient.ChatClientRequestSpec {
        val spec = chatClient.prompt()
        return when (thinking) {
            ThinkingMode.DEFAULT -> spec
            ThinkingMode.ENABLED -> spec.options(thinkingOptions("enabled"))
            ThinkingMode.DISABLED -> spec.options(thinkingOptions("disabled"))
        }
    }

    /** 生成只携带 thinking 字段的请求选项，其余选项沿用全局配置。 */
    private fun thinkingOptions(type: String): OpenAiChatOptions.Builder =
        OpenAiChatOptions.builder().extraBody(mapOf("thinking" to mapOf("type" to type)))

    /** 生成一次探测用的随机校验码。 */
    private fun newProbeCode(): String = UUID.randomUUID().toString().take(8)

    /** 取模型最终回复文本。 */
    private fun replyOf(response: ChatResponse?): String = response?.result?.output?.text.orEmpty().trim()

    /** 满足预期时记为通过并附用量与是否返回思考内容，否则记为回复不符合预期。 */
    private fun expect(satisfied: Boolean, detail: String, response: ChatResponse?): CheckOutcome =
        if (satisfied) {
            CheckOutcome.Passed("$detail；${reasoningNote(response)}", usageOf(response))
        } else {
            CheckOutcome.Failed(ModelFailure.UNEXPECTED_REPLY, detail)
        }

    /** 说明回复是否带有思考内容，用于确认思考模式开关是否生效。 */
    private fun reasoningNote(response: ChatResponse?): String {
        val reasoning = response?.result?.output?.metadata?.get("reasoningContent")?.toString()
        return if (reasoning.isNullOrBlank()) "无思考内容" else "含思考内容 ${reasoning.length} 字"
    }

    /** 读取本次调用的 token 用量。 */
    private fun usageOf(response: ChatResponse?): TokenUsage? = response?.metadata?.usage?.let {
        TokenUsage(it.promptTokens, it.completionTokens, it.totalTokens)
    }
}

/** 探测用工具：返回本次探测生成的校验码，并记录被调用次数。 */
class ProbeCodeTool(val code: String) {
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
data class ArithmeticAnswer(val sum: Int, val reading: String)
