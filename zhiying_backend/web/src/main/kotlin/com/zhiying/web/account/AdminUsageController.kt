// 管理员用量看板接口：每日、按用户、按条目聚合，普通账号不能读取。
package com.zhiying.web.account

import com.zhiying.application.quota.AdminUsage
import com.zhiying.domain.account.Account
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RequestAttribute
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping("/api/admin/usage")
class AdminUsageController(
    private val usage: AdminUsage,
) {
    @GetMapping("/daily")
    fun daily(
        @RequestAttribute("user") user: Account,
        @RequestParam(defaultValue = "30") days: Int,
    ) = usage.daily(user, days)

    @GetMapping("/users")
    fun users(
        @RequestAttribute("user") user: Account,
    ) = usage.users(user)

    @GetMapping("/books")
    fun books(
        @RequestAttribute("user") user: Account,
    ) = usage.books(user)
}
