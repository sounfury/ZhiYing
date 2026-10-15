// 管理员用量看板：按配置时区读取独立流水，今日额外计入未结算任务的实时 token。
package com.zhiying.application.quota

import com.zhiying.application.account.Accounts
import com.zhiying.application.analyze.run.AnalysisRunner
import com.zhiying.application.error.AppException
import com.zhiying.application.error.ErrorCode
import com.zhiying.domain.account.Account
import org.springframework.stereotype.Service
import java.time.LocalDate

data class DailyUsage(
    val date: LocalDate,
    val tokens: Long,
)

data class UserUsage(
    val userId: String,
    val username: String,
    val chars: Long,
    val tokens: Long,
    val books: Long,
)

data class BookUsage(
    val itemId: String,
    val username: String,
    val title: String,
    val tokens: Long,
)

interface AdminUsageStore {
    fun users(): List<UserUsage>

    fun books(): List<BookUsage>
}

@Service
class AdminUsage(
    private val accounts: Accounts,
    private val store: AdminUsageStore,
    private val ledger: UsageLedger,
    private val quota: QuotaUsage,
    private val runner: AnalysisRunner,
) {
    fun daily(
        user: Account,
        days: Int,
    ): Map<String, Any> {
        accounts.requireAdministrator(user)
        if (days !in 1..30) throw AppException(ErrorCode.INVALID_ARGUMENT, "days 必须为 1–30")
        return runner.withRegistrationLock {
            val zone = quota.settings.timeZone
            val today = LocalDate.now(zone)
            val daily =
                (days - 1 downTo 0).map { offset ->
                    val date = today.minusDays(offset.toLong())
                    val tokens = ledger.tokensBetween(date.atStartOfDay(zone).toInstant(), date.plusDays(1).atStartOfDay(zone).toInstant())
                    DailyUsage(date, tokens + if (date == today) runner.unsettledTokens() else 0)
                }
            mapOf("daily" to daily, "limits" to quota.limits(), "timeZone" to zone.id)
        }
    }

    fun users(user: Account): List<UserUsage> {
        accounts.requireAdministrator(user)
        return store.users()
    }

    fun books(user: Account): List<BookUsage> {
        accounts.requireAdministrator(user)
        return store.books()
    }
}
