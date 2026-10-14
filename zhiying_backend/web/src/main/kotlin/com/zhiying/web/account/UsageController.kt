// 本人用量 HTTP 接口：只返回当前登录账号的书数与累计分析字数。
package com.zhiying.web.account

import com.zhiying.application.account.Accounts
import com.zhiying.application.quota.PersonalUsage
import com.zhiying.application.quota.QuotaUsage
import com.zhiying.domain.account.Account
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RequestAttribute
import org.springframework.web.bind.annotation.RestController

@RestController
class UsageController(
    private val quota: QuotaUsage,
    private val accounts: Accounts,
) {
    @GetMapping("/api/me/usage")
    fun usage(
        @RequestAttribute("user", required = false) user: Account?,
    ): PersonalUsage = quota.personal(accounts.requireUser(user))
}
