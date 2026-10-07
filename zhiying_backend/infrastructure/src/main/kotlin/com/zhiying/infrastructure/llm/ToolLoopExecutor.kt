// 工具循环执行器：多轮「模型调用 → 执行工具 → 回传结果」，直到调用方判定完成、模型停手或步数用尽。
// 只负责循环与执行统计，不理解工具语义；工具的校验与状态在调用方（如章阅读会话）里。
package com.zhiying.infrastructure.llm

import com.zhiying.application.diagnostics.ModelFailure
import com.zhiying.application.llm.ModelCallControl
import com.zhiying.application.llm.ModelCallStats
import org.springframework.ai.chat.messages.AssistantMessage
import org.springframework.ai.chat.messages.Message
import org.springframework.ai.chat.messages.SystemMessage
import org.springframework.ai.chat.messages.ToolResponseMessage
import org.springframework.ai.chat.messages.UserMessage
import org.springframework.ai.tool.ToolCallback
import org.springframework.stereotype.Component

/**
 * 一次工具循环的请求。
 *
 * 入参：[system]、[user] 初始提示；[tools] 可用工具；[maxSteps] 最大模型调用轮数；
 * [model]、[thinking] 同 [CallSpec]；[control] 任务级预算与取消；
 * [isDone] 每轮工具执行后询问调用方是否已得到最终结果（如已成功提交）；
 * [nudge] 模型不调工具且 [isDone] 仍为 false 时追加的提醒语，[nudges] 为最多提醒次数。
 */
class ToolLoopRequest(
    val system: String,
    val user: String,
    val tools: List<ToolCallback>,
    val maxSteps: Int,
    val model: String? = null,
    val thinking: Boolean = false,
    val control: ModelCallControl = ModelCallControl(),
    val nudge: String = "",
    val nudges: Int = 0,
    val isDone: () -> Boolean,
)

/** 工具循环的结束方式。 */
sealed interface LoopEnd {
    /** 调用方判定已完成。 */
    data object Finished : LoopEnd

    /** 模型不再调用工具，但调用方尚未完成（提醒次数已用完）。 */
    data object ModelStopped : LoopEnd

    /** 用尽最大步数仍未完成。 */
    data object StepsExhausted : LoopEnd

    /** 模型请求失败、预算耗尽或被取消。 */
    data class Failed(val failure: ModelFailure, val message: String) : LoopEnd
}

/** 工具循环的结果：结束方式、实际轮数、模型最后一次的文字回复与统计。 */
data class ToolLoopOutcome(
    val end: LoopEnd,
    val steps: Int,
    val lastText: String,
    val stats: ModelCallStats,
)

/**
 * 工具循环执行器。
 *
 * 每轮：请求模型 → 把模型回复（含思考内容）原样追加 → 逐个执行工具并把结果回传。
 * 思考模式下 AssistantMessage 的思考内容保存在其元数据中，随消息一起回传，满足 DeepSeek 的多轮要求。
 */
@Component
class ToolLoopExecutor(private val invoker: ModelInvoker) {

    /**
     * 运行工具循环。
     *
     * 出参：[ToolLoopOutcome]；失败、预算耗尽、取消都在 [LoopEnd.Failed] 中表达，不抛异常。
     * 调用方的工具回调异常会被转成错误 JSON 回传给模型，不会中断循环。
     */
    fun run(request: ToolLoopRequest): ToolLoopOutcome {
        val tools = request.tools.associateBy { it.toolDefinition.name() }
        val messages = mutableListOf<Message>(SystemMessage(request.system), UserMessage(request.user))
        val spec = CallSpec(request.model, request.thinking, request.tools)
        val meter = CallMeter()
        var nudgesLeft = request.nudges
        var lastText = ""
        for (step in 1..request.maxSteps) {
            // 流程：请求模型 → 有工具调用则执行并回传 → 完成判定；无工具调用则提醒或结束
            val reply = when (val result = invoker.invoke(messages, spec, request.control, meter)) {
                is InvokeResult.Failed -> return outcome(LoopEnd.Failed(result.failure, result.message), step, lastText, meter)
                is InvokeResult.Reply -> result.response.result?.output ?: AssistantMessage("")
            }
            lastText = reply.text.orEmpty().ifBlank { lastText }
            messages += reply
            if (reply.hasToolCalls()) {
                messages += executeTools(reply, tools)
                if (request.isDone()) return outcome(LoopEnd.Finished, step, lastText, meter)
            } else if (request.isDone()) {
                return outcome(LoopEnd.Finished, step, lastText, meter)
            } else if (nudgesLeft > 0) {
                nudgesLeft--
                messages += UserMessage(request.nudge)
            } else {
                return outcome(LoopEnd.ModelStopped, step, lastText, meter)
            }
        }
        return outcome(LoopEnd.StepsExhausted, request.maxSteps, lastText, meter)
    }

    /** 执行模型要求的全部工具调用，汇成一条工具结果消息；未知工具与工具异常转为错误 JSON。 */
    private fun executeTools(reply: AssistantMessage, tools: Map<String, ToolCallback>): ToolResponseMessage {
        val responses = reply.toolCalls.map { call ->
            val data = tools[call.name()]?.let { tool ->
                try {
                    tool.call(call.arguments())
                } catch (e: Exception) {
                    LlmJson.write(mapOf("error" to "TOOL_FAILED", "message" to (e.message ?: e.javaClass.name)))
                }
            } ?: LlmJson.write(mapOf("error" to "UNKNOWN_TOOL", "message" to "没有名为 ${call.name()} 的工具"))
            ToolResponseMessage.ToolResponse(call.id(), call.name(), data)
        }
        return ToolResponseMessage.builder().responses(responses).build()
    }

    /** 汇总结束方式与统计。 */
    private fun outcome(end: LoopEnd, steps: Int, lastText: String, meter: CallMeter) =
        ToolLoopOutcome(end, steps, lastText, meter.stats())
}
