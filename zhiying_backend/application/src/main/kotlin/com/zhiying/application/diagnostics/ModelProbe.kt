package com.zhiying.application.diagnostics

/** 探测目标：模型服务地址与模型名，不含密钥。 */
data class ModelTarget(val baseUrl: String, val model: String)

/** 探测时的思考模式。 */
enum class ThinkingMode {
    /** 沿用全局配置（当前默认关闭思考，速度优先）。 */
    DEFAULT,

    /** 显式开启。 */
    ENABLED,

    /** 显式关闭。 */
    DISABLED,
}

/** 分析依赖的模型协议，逐项探测。 */
enum class ProbeCheck {
    /** 普通对话往返。 */
    CHAT,

    /** 工具调用往返：章阅读 Agent 依赖它读原文、提交观察。 */
    TOOL_CALL,

    /** 结构化输出：身份歧义、类型归一等定向判断依赖它。 */
    STRUCTURED_OUTPUT,
}

/** 模型调用失败的执行类别。执行失败不等于任何语义结论。 */
enum class ModelFailure {
    /** 密钥无效或无权限。 */
    AUTHENTICATION,

    /** 账户余额或额度不足。 */
    INSUFFICIENT_BALANCE,

    /** 被限流。 */
    RATE_LIMITED,

    /** 请求超时。 */
    TIMEOUT,

    /** 网络不可达或连接中断。 */
    NETWORK,

    /** 服务端拒绝了请求参数。 */
    REJECTED_REQUEST,

    /** 服务端内部错误。 */
    PROVIDER_ERROR,

    /** 请求成功，但回复不符合预期（探测不符，或结构化回复无法解析 / 校验）。 */
    UNEXPECTED_REPLY,

    /** 请求数、token 或时间预算已耗尽，未再发出请求。 */
    BUDGET_EXHAUSTED,

    /** 调用方取消了任务，未再发出请求。 */
    CANCELLED,

    /** 工具循环用尽最大步数仍未得出结果。 */
    STEPS_EXHAUSTED,
}

/** 一次调用的 token 用量。 */
data class TokenUsage(val input: Int, val output: Int, val total: Int)

/** 单项探测的结果。 */
sealed interface CheckOutcome {
    /** 通过：附回复摘要与用量。 */
    data class Passed(val detail: String, val usage: TokenUsage?) : CheckOutcome

    /** 失败：附执行失败类别与原始信息。 */
    data class Failed(val failure: ModelFailure, val message: String) : CheckOutcome
}

/** 模型探针：对真实模型服务执行单项协议检查。实现方负责把厂商异常归类为 [ModelFailure]。 */
interface ModelProbe {
    /** 当前探测目标。 */
    fun target(): ModelTarget

    /** 以指定思考模式执行一项检查；每次调用都会向模型服务发出真实请求。 */
    fun run(check: ProbeCheck, thinking: ThinkingMode): CheckOutcome
}
