// 管理员通用设置接口：列出配额与系统提示，保存覆盖值或删除后恢复默认。
package com.zhiying.web.account

import com.zhiying.application.settings.AdminSettings
import com.zhiying.domain.account.Account
import org.springframework.http.HttpStatus
import org.springframework.web.bind.annotation.DeleteMapping
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PutMapping
import org.springframework.web.bind.annotation.RequestAttribute
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.ResponseStatus
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping("/api/admin/settings")
class AppSettingsController(
    private val settings: AdminSettings,
) {
    @GetMapping
    fun list(
        @RequestAttribute("user") user: Account,
    ) = settings.list(user)

    @PutMapping("/{group}/{key}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun save(
        @RequestAttribute("user") user: Account,
        @PathVariable group: String,
        @PathVariable key: String,
        @RequestBody body: SettingRequest,
    ) = settings.save(user, group, key, body.value)

    @DeleteMapping("/{group}/{key}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun reset(
        @RequestAttribute("user") user: Account,
        @PathVariable group: String,
        @PathVariable key: String,
    ) = settings.reset(user, group, key)
}

data class SettingRequest(
    val value: Any? = null,
)
