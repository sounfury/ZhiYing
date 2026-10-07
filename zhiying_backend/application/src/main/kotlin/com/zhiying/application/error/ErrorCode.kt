// 全局错误码：系统对外暴露的全部稳定错误标识，统一在此登记，前端与日志按它区分错误。
package com.zhiying.application.error

/**
 * 全局错误码。
 *
 * 只登记需要调用方区分处理的错误；HTTP 状态映射由 web 层负责，新增错误码时编译器会提示补齐映射。
 * 模型调用的执行失败（[com.zhiying.application.diagnostics.ModelFailure]）是业务结果而非错误码，不在此登记。
 */
enum class ErrorCode(val defaultMessage: String) {
    /** 请求参数缺失、格式错误或取值不合法。 */
    INVALID_ARGUMENT("请求参数不合法"),

    /** 请求的资源不存在。 */
    NOT_FOUND("资源不存在"),

    /** 上传的文件不是可解析的电子书，或书中没有可用章节。 */
    UNREADABLE_BOOK("无法解析该电子书"),

    /** 该书已有分析任务在运行，不能重复启动。 */
    ANALYSIS_ALREADY_RUNNING("该书正在分析中"),

    /** 请求方法、内容类型等不被接口支持。 */
    REQUEST_NOT_SUPPORTED("不支持该请求"),

    /** 未预期的内部错误，详情只记日志，不返回给调用方。 */
    INTERNAL_ERROR("服务内部错误"),
}
