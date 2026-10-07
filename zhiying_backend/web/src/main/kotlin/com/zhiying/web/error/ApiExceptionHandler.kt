// 全局异常处理：把应用异常、框架请求错误与未预期异常统一转换为带错误码的 ProblemDetail 响应。
package com.zhiying.web.error

import com.zhiying.application.error.AppException
import com.zhiying.application.error.ErrorCode
import org.slf4j.LoggerFactory
import org.springframework.http.HttpHeaders
import org.springframework.http.HttpStatus
import org.springframework.http.HttpStatusCode
import org.springframework.http.ProblemDetail
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.ExceptionHandler
import org.springframework.web.bind.annotation.RestControllerAdvice
import org.springframework.web.context.request.WebRequest
import org.springframework.web.servlet.mvc.method.annotation.ResponseEntityExceptionHandler

/**
 * 错误响应统一为 RFC 9457 ProblemDetail，并附加 `code` 字段（[ErrorCode] 名称）。
 *
 * 框架自身的请求错误（缺参数、类型不符、路由不存在等）由父类生成 ProblemDetail，这里按状态码补上错误码。
 */
@RestControllerAdvice
class ApiExceptionHandler : ResponseEntityExceptionHandler() {

    private val log = LoggerFactory.getLogger(ApiExceptionHandler::class.java)

    /** 应用异常：按错误码映射 HTTP 状态，说明原样返回。 */
    @ExceptionHandler(AppException::class)
    fun handleApp(e: AppException): ResponseEntity<ProblemDetail> = problem(e.code, e.message ?: e.code.defaultMessage)

    /** 未预期异常：记录完整堆栈，响应只给通用说明，不泄露内部细节。 */
    @ExceptionHandler(Exception::class)
    fun handleUnexpected(e: Exception): ResponseEntity<ProblemDetail> {
        log.error("未处理的异常", e)
        return problem(ErrorCode.INTERNAL_ERROR, ErrorCode.INTERNAL_ERROR.defaultMessage)
    }

    /** 框架请求错误：沿用父类生成的 ProblemDetail，按状态码补充错误码。 */
    override fun handleExceptionInternal(
        ex: Exception,
        body: Any?,
        headers: HttpHeaders,
        statusCode: HttpStatusCode,
        request: WebRequest,
    ): ResponseEntity<Any>? {
        val response = super.handleExceptionInternal(ex, body, headers, statusCode, request)
        (response?.body as? ProblemDetail)?.setProperty(CODE, codeOf(statusCode).name)
        return response
    }

    /** 由错误码与说明构造响应。 */
    private fun problem(code: ErrorCode, detail: String): ResponseEntity<ProblemDetail> {
        val status = statusOf(code)
        val body = ProblemDetail.forStatusAndDetail(status, detail).apply { setProperty(CODE, code.name) }
        return ResponseEntity.status(status).body(body)
    }

    private companion object {
        /** ProblemDetail 中错误码字段名。 */
        const val CODE = "code"
    }
}

/** 错误码到 HTTP 状态的唯一映射；穷尽 when 保证新增错误码必须在此登记。 */
internal fun statusOf(code: ErrorCode): HttpStatus = when (code) {
    ErrorCode.INVALID_ARGUMENT -> HttpStatus.BAD_REQUEST
    ErrorCode.NOT_FOUND -> HttpStatus.NOT_FOUND
    ErrorCode.UNREADABLE_BOOK -> HttpStatus.UNPROCESSABLE_CONTENT
    ErrorCode.ANALYSIS_ALREADY_RUNNING -> HttpStatus.CONFLICT
    ErrorCode.REQUEST_NOT_SUPPORTED -> HttpStatus.METHOD_NOT_ALLOWED
    ErrorCode.INTERNAL_ERROR -> HttpStatus.INTERNAL_SERVER_ERROR
}

/** 框架请求错误的状态码反查错误码：404 为资源不存在，405 / 406 / 415 为不支持，其余 4xx 为参数错误。 */
internal fun codeOf(status: HttpStatusCode): ErrorCode = when {
    status.value() == 404 -> ErrorCode.NOT_FOUND
    status.value() in setOf(405, 406, 415) -> ErrorCode.REQUEST_NOT_SUPPORTED
    status.is4xxClientError -> ErrorCode.INVALID_ARGUMENT
    else -> ErrorCode.INTERNAL_ERROR
}
