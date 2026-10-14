// 账号领域模型：用户名、密码格式和角色规则；不接触认证协议或存储。
package com.zhiying.domain.account

import java.util.UUID

enum class AccountRole { ADMIN, USER }

data class Account(
    val id: String,
    val username: String,
    val role: AccountRole,
) {
    init {
        require(username.matches(Regex("[A-Za-z0-9_]{3,32}"))) { "用户名须为 3–32 位字母、数字或下划线" }
    }

    companion object {
        fun create(
            username: String,
            password: String,
            role: AccountRole,
        ): Account {
            validatePassword(password)
            return Account(UUID.randomUUID().toString(), username, role)
        }

        fun validatePassword(password: String) {
            require(password.length in 8..128) { "密码须为 8–128 个字符" }
        }
    }
}
