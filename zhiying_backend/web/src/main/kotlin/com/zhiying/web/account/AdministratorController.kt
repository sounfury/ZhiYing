// 管理员账号接口：发放限次邀请码、列账号和重置密码；角色检查由边界及应用用例执行。
package com.zhiying.web.account

import com.zhiying.application.account.Accounts
import com.zhiying.application.account.Invitation
import com.zhiying.application.error.AppException
import com.zhiying.application.error.ErrorCode
import com.zhiying.domain.account.Account
import org.springframework.http.HttpStatus
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestAttribute
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.ResponseStatus
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping("/api/admin")
class AdministratorController(
    private val accounts: Accounts,
) {
    @GetMapping("/invitations")
    fun invitations(
        @RequestAttribute("user") user: Account,
    ): Map<String, List<Invitation>> = mapOf("invitations" to accounts.listInvitations(user))

    @PostMapping("/invitations")
    fun createInvitation(
        @RequestAttribute("user") user: Account,
        @RequestBody body: InvitationRequest,
    ): Invitation = accounts.createInvitation(user, body.maxUses, invitationLimit(body.maxBooks), invitationLimit(body.maxTokens))

    private fun invitationLimit(value: Any?): Long? =
        when (value) {
            null -> null
            is Byte, is Short, is Int, is Long -> (value as Number).toLong()
            else -> throw AppException(ErrorCode.INVALID_ARGUMENT, "邀请码额度必须是非负整数或 null")
        }

    @GetMapping("/users")
    fun users(
        @RequestAttribute("user") user: Account,
    ): Map<String, List<Account>> = mapOf("users" to accounts.listUsers(user))

    @PostMapping("/users/{userId}/password")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun resetPassword(
        @RequestAttribute("user") user: Account,
        @PathVariable userId: String,
        @RequestBody body: PasswordRequest,
    ) = accounts.resetPassword(user, userId, body.password)
}

data class InvitationRequest(
    val maxUses: Int,
    val maxBooks: Any? = null,
    val maxTokens: Any? = null,
)

data class PasswordRequest(
    val password: String,
)
