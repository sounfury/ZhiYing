package com.zhiying.infrastructure.llm

import com.openai.errors.OpenAIIoException
import com.openai.errors.OpenAIServiceException
import com.zhiying.application.diagnostics.ModelFailure
import java.io.IOException
import java.io.InterruptedIOException
import java.util.concurrent.TimeoutException

/**
 * 把模型调用异常归类为执行失败类别。
 *
 * 沿异常链查找，兼容被框架包装的情况：先看服务端状态码，再看超时与网络错误，其余视为回复不符合预期。
 */
internal fun classifyFailure(error: Throwable): ModelFailure {
    val chain = generateSequence(error) { it.cause }.take(MAX_CAUSE_DEPTH).toList()
    val status = chain.firstNotNullOfOrNull { (it as? OpenAIServiceException)?.statusCode() }
    return when {
        status != null -> failureOfStatus(status)
        chain.any { it is InterruptedIOException || it is TimeoutException } -> ModelFailure.TIMEOUT
        chain.any { it is OpenAIIoException || it is IOException } -> ModelFailure.NETWORK
        else -> ModelFailure.UNEXPECTED_REPLY
    }
}

/** 按 HTTP 状态码归类；DeepSeek 用 402 表示余额不足。 */
private fun failureOfStatus(status: Int): ModelFailure = when (status) {
    401, 403 -> ModelFailure.AUTHENTICATION
    402 -> ModelFailure.INSUFFICIENT_BALANCE
    429 -> ModelFailure.RATE_LIMITED
    in 400..499 -> ModelFailure.REJECTED_REQUEST
    else -> ModelFailure.PROVIDER_ERROR
}

/** 异常链的最大追溯深度，防止异常自引用造成死循环。 */
private const val MAX_CAUSE_DEPTH = 16
