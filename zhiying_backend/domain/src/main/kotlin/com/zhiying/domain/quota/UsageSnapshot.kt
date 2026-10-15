// 用量领域规则：以不可变用量快照判断上传和分析是否会超限，不执行存储或模型调用。
package com.zhiying.domain.quota

/** 各项额度，0 表示不限；文件大小以字节计。 */
data class QuotaLimits(
    val maxBooks: Long,
    val maxAnalysisChars: Long,
    val maxFileBytes: Long,
    val maxConcurrentTasks: Long,
    val dailyTokenBudget: Long,
    val maxTokens: Long = 0,
)

sealed interface QuotaCheck {
    data object Allowed : QuotaCheck

    data class Exceeded(
        val item: QuotaItem,
        val needed: Long,
        val remaining: Long,
    ) : QuotaCheck
}

enum class QuotaItem { FILE_SIZE, BOOKS, DAILY_TOKENS, CONCURRENT_TASKS, ANALYSIS_CHARS, TOKENS }

/** 字数包含未结算任务的预占；管理员只豁免每人额度。 */
data class UsageSnapshot(
    val limits: QuotaLimits,
    val books: Long,
    val chars: Long,
    val runningTasks: Long = 0,
    val todayTokens: Long = 0,
    val isAdministrator: Boolean = false,
    val tokens: Long = 0,
) {
    fun checkUpload(fileBytes: Long): QuotaCheck {
        val file = check(QuotaItem.FILE_SIZE, limits.maxFileBytes, 0, fileBytes)
        if (file != QuotaCheck.Allowed) return file
        return if (isAdministrator) QuotaCheck.Allowed else check(QuotaItem.BOOKS, limits.maxBooks, books, 1)
    }

    fun checkAnalysis(chars: Long): QuotaCheck {
        if (limits.dailyTokenBudget > 0 && todayTokens >= limits.dailyTokenBudget) {
            return QuotaCheck.Exceeded(QuotaItem.DAILY_TOKENS, 1, 0)
        }
        if (isAdministrator) return QuotaCheck.Allowed
        if (limits.maxTokens > 0 && tokens >= limits.maxTokens) {
            return QuotaCheck.Exceeded(QuotaItem.TOKENS, 1, 0)
        }
        val concurrent = check(QuotaItem.CONCURRENT_TASKS, limits.maxConcurrentTasks, runningTasks, 1)
        if (concurrent != QuotaCheck.Allowed) return concurrent
        return check(QuotaItem.ANALYSIS_CHARS, limits.maxAnalysisChars, this.chars, chars)
    }

    private fun check(
        item: QuotaItem,
        limit: Long,
        used: Long,
        needed: Long,
    ): QuotaCheck {
        if (limit == 0L) return QuotaCheck.Allowed
        val remaining = (limit - used).coerceAtLeast(0)
        return if (needed <= remaining) QuotaCheck.Allowed else QuotaCheck.Exceeded(item, needed, remaining)
    }
}
