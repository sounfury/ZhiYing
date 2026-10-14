// 账号用例：邀请码注册、登录会话、管理员放号与密码重置，按顺序显式调用存储和密码算法。
package com.zhiying.application.account

import com.zhiying.application.error.AppException
import com.zhiying.application.error.ErrorCode
import com.zhiying.domain.account.Account
import com.zhiying.domain.account.AccountRole
import org.springframework.stereotype.Service
import java.time.Duration
import java.time.Instant
import java.security.SecureRandom
import java.util.Base64
import java.util.UUID

data class AccountSettings(
    val sessionLifetime: Duration,
    val secureCookie: Boolean,
)

data class Invitation(
    val code: String,
    val maxUses: Int,
    val usedCount: Int,
)

data class StoredAccount(
    val account: Account,
    val passwordHash: String,
)

data class Login(
    val user: Account,
    val token: String,
)

interface PasswordHasher {
    fun hash(password: String): String

    fun matches(
        password: String,
        hash: String,
    ): Boolean
}

interface AccountStore {
    fun administrator(): Account?

    fun initializeAdministrator(
        account: Account,
        passwordHash: String,
    )

    fun findByUsername(username: String): StoredAccount?

    fun register(
        account: Account,
        passwordHash: String,
        inviteCode: String,
    )

    fun saveSession(
        token: String,
        userId: String,
        expiresAt: Instant,
    )

    fun sessionUser(
        token: String,
        now: Instant,
    ): Account?

    fun deleteSession(token: String)

    fun listUsers(): List<Account>

    fun createInvitation(
        invitation: Invitation,
        createdBy: String,
    )

    fun listInvitations(): List<Invitation>

    fun resetPassword(
        userId: String,
        passwordHash: String,
    )
}

@Service
class Accounts(
    private val store: AccountStore,
    private val passwords: PasswordHasher,
    val settings: AccountSettings,
) {
    fun initializeAdministrator(
        username: String,
        password: String,
    ) {
        if (store.administrator() != null) return
        val account = credentials { Account.create(username, password, AccountRole.ADMIN) }
        store.initializeAdministrator(account, passwords.hash(password))
    }

    fun register(
        username: String,
        password: String,
        inviteCode: String,
    ): Login {
        val account = credentials { Account.create(username, password, AccountRole.USER) }
        store.register(account, passwords.hash(password), inviteCode)
        return loginSession(account)
    }

    fun login(
        username: String,
        password: String,
    ): Login {
        if (password.length !in 8..128) throw AppException(ErrorCode.INVALID_CREDENTIALS)
        val stored = store.findByUsername(username) ?: throw AppException(ErrorCode.INVALID_CREDENTIALS)
        if (!passwords.matches(password, stored.passwordHash)) throw AppException(ErrorCode.INVALID_CREDENTIALS)
        return loginSession(stored.account)
    }

    fun currentUser(token: String?): Account? = token?.let { store.sessionUser(it, Instant.now()) }

    fun logout(token: String?) {
        if (token != null) store.deleteSession(token)
    }

    fun requireUser(user: Account?): Account = user ?: throw AppException(ErrorCode.UNAUTHENTICATED)

    fun requireAdministrator(user: Account?): Account {
        val account = requireUser(user)
        if (account.role != AccountRole.ADMIN) throw AppException(ErrorCode.FORBIDDEN)
        return account
    }

    fun listUsers(actor: Account): List<Account> {
        requireAdministrator(actor)
        return store.listUsers()
    }

    fun createInvitation(
        actor: Account,
        maxUses: Int,
    ): Invitation {
        requireAdministrator(actor)
        if (maxUses < 1) throw AppException(ErrorCode.INVALID_ARGUMENT, "邀请码可用次数必须为正")
        val invitation = Invitation(UUID.randomUUID().toString(), maxUses, 0)
        store.createInvitation(invitation, actor.id)
        return invitation
    }

    fun listInvitations(actor: Account): List<Invitation> {
        requireAdministrator(actor)
        return store.listInvitations()
    }

    fun resetPassword(
        actor: Account,
        userId: String,
        password: String,
    ) {
        requireAdministrator(actor)
        credentials { Account.validatePassword(password) }
        store.resetPassword(userId, passwords.hash(password))
    }

    private fun loginSession(account: Account): Login {
        val token = Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(32).also(SecureRandom()::nextBytes))
        store.saveSession(token, account.id, Instant.now().plus(settings.sessionLifetime))
        return Login(account, token)
    }

    private fun <T> credentials(validate: () -> T): T =
        try {
            validate()
        } catch (e: IllegalArgumentException) {
            throw AppException(ErrorCode.INVALID_ARGUMENT, e.message!!)
        }
}
