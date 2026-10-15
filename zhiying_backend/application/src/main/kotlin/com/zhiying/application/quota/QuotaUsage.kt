// 用量用例：读取独立流水与本人书架、调用领域规则，并把拒绝原因转换为对外错误。
package com.zhiying.application.quota

import com.zhiying.application.account.AccountStore
import com.zhiying.application.analyze.run.AnalysisTask
import com.zhiying.application.analyze.run.TaskId
import com.zhiying.application.analyze.run.TaskUsage
import com.zhiying.application.error.AppException
import com.zhiying.application.error.ErrorCode
import com.zhiying.application.library.BookRepository
import com.zhiying.application.library.ExampleBooks
import com.zhiying.application.settings.AdminSettings
import com.zhiying.domain.account.Account
import com.zhiying.domain.account.AccountRole
import com.zhiying.domain.library.BookId
import com.zhiying.domain.quota.QuotaCheck
import com.zhiying.domain.quota.QuotaItem
import com.zhiying.domain.quota.QuotaLimits
import com.zhiying.domain.quota.UsageSnapshot
import org.springframework.stereotype.Service
import java.time.Instant
import java.time.ZoneId

/** 独立于书和分析结果的用量存储，删除书不退还用量。 */
interface UsageLedger {
    fun usedChars(userId: String): Long

    fun usedTokens(userId: String): Long

    fun tokensBetween(
        start: Instant,
        end: Instant,
    ): Long

    /** 在同一事务中创建任务和字数预占流水，失败时一起回滚。 */
    fun reserve(
        task: AnalysisTask,
        userId: String,
        chars: Long,
        itemId: BookId,
    )

    fun settle(
        taskId: TaskId,
        chars: Long,
        tokens: Long,
        usage: TaskUsage,
    )

    /** 按本人条目统计历史用量，删除或清空分析不影响流水。 */
    fun usageByItem(
        userId: String,
        itemIds: Collection<BookId>,
    ): Map<BookId, TaskUsage>

    /** 启动时按各章首次读取标记和最后落库 token 结算所有遗留流水。 */
    fun settleInterrupted()
}

data class QuotaSettings(
    val timeZone: ZoneId,
)

data class UsageAmount(
    val used: Long,
    val limit: Long,
)

data class PersonalUsage(
    val books: UsageAmount,
    val chars: UsageAmount,
)

@Service
class QuotaUsage(
    private val ledger: UsageLedger,
    private val books: BookRepository,
    private val examples: ExampleBooks,
    val settings: QuotaSettings,
    private val adminSettings: AdminSettings,
    private val accounts: AccountStore,
) {
    fun snapshot(
        user: Account,
        runningTasks: Long = 0,
        todayTokens: Long = 0,
    ): UsageSnapshot {
        val global = adminSettings.quotaLimits()
        val personal = accounts.quota(user.id)
        return UsageSnapshot(
            global.copy(maxBooks = personal.maxBooks ?: global.maxBooks, maxTokens = personal.maxTokens ?: global.maxTokens),
            books.listBooks(user.id).count { examples.slug(it.itemId) == null }.toLong(),
            ledger.usedChars(user.id),
            runningTasks,
            todayTokens,
            user.role == AccountRole.ADMIN,
            ledger.usedTokens(user.id),
        )
    }

    fun personal(user: Account): PersonalUsage {
        val usage = snapshot(user)
        return PersonalUsage(
            UsageAmount(usage.books, if (usage.isAdministrator) 0 else usage.limits.maxBooks),
            UsageAmount(usage.chars, if (usage.isAdministrator) 0 else usage.limits.maxAnalysisChars),
        )
    }

    fun limits(): QuotaLimits = adminSettings.quotaLimits()

    fun requireAllowed(check: QuotaCheck) {
        if (check !is QuotaCheck.Exceeded) return
        val message =
            when (check.item) {
                QuotaItem.FILE_SIZE -> "文件过大：需 ${check.needed} 字节，上限 ${check.remaining} 字节"
                QuotaItem.BOOKS -> "书数已达上限：需 ${check.needed} 本，剩余 ${check.remaining} 本"
                QuotaItem.CONCURRENT_TASKS -> "同时分析任务数不足：需 ${check.needed} 个，剩余 ${check.remaining} 个"
                QuotaItem.ANALYSIS_CHARS -> "分析字数不足：本次需 ${check.needed} 字，剩余 ${check.remaining} 字"
                QuotaItem.TOKENS -> "分析额度已用完"
                QuotaItem.DAILY_TOKENS -> ErrorCode.DAILY_BUDGET_EXHAUSTED.defaultMessage
            }
        val code =
            when (check.item) {
                QuotaItem.FILE_SIZE -> ErrorCode.FILE_TOO_LARGE
                QuotaItem.DAILY_TOKENS -> ErrorCode.DAILY_BUDGET_EXHAUSTED
                else -> ErrorCode.QUOTA_EXCEEDED
            }
        throw AppException(code, message)
    }
}
