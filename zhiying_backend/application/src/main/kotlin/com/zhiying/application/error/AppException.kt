// 应用异常：用例拒绝请求时抛出的唯一异常类型，携带全局错误码，由 web 层统一转换为响应。
package com.zhiying.application.error

/**
 * 携带错误码的应用异常。
 *
 * 入参：[code] 全局错误码；[message] 返回给调用方的说明，默认取错误码自带说明；[cause] 原始异常。
 */
class AppException(
    val code: ErrorCode,
    message: String = code.defaultMessage,
    cause: Throwable? = null,
) : RuntimeException(message, cause)
