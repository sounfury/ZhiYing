// 账号 SQLite 存储：事务内消耗邀请码、创建账号和撤销登录；仅保存会话令牌的摘要。
package com.zhiying.infrastructure.persistence.account

import com.zhiying.application.account.AccountStore
import com.zhiying.application.account.Invitation
import com.zhiying.application.account.StoredAccount
import com.zhiying.application.error.AppException
import com.zhiying.application.error.ErrorCode
import com.zhiying.domain.account.Account
import com.zhiying.domain.account.AccountRole
import org.springframework.context.annotation.DependsOn
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.stereotype.Repository
import org.springframework.transaction.annotation.Transactional
import java.security.MessageDigest
import java.sql.ResultSet
import java.time.Instant

@Repository
@DependsOn("instantReuseMigration")
class SqliteAccountStore(
    private val jdbc: JdbcClient,
) : AccountStore {
    override fun administrator(): Account? =
        jdbc
            .sql("SELECT * FROM accounts WHERE role = 'ADMIN' ORDER BY created_at LIMIT 1")
            .query { rs, _ -> accountOf(rs) }
            .optional()
            .orElse(null)

    @Transactional
    override fun initializeAdministrator(
        account: Account,
        passwordHash: String,
    ) {
        insertAccount(account, passwordHash)
        jdbc
            .sql("INSERT INTO shelf_items (id, user_id, book_id, original_name, created_at) SELECT id, ?, id, original_name, imported_at FROM books WHERE id NOT IN (SELECT book_id FROM shelf_items UNION SELECT pending_book_id FROM shelf_items WHERE pending_book_id IS NOT NULL)")
            .param(account.id)
            .update()
    }

    override fun findByUsername(username: String): StoredAccount? =
        jdbc
            .sql("SELECT * FROM accounts WHERE username = ?")
            .param(username)
            .query { rs, _ -> StoredAccount(accountOf(rs), rs.getString("password_hash")) }
            .optional()
            .orElse(null)

    @Transactional
    override fun register(
        account: Account,
        passwordHash: String,
        inviteCode: String,
    ) {
        val consumed =
            jdbc
                .sql("UPDATE invitations SET used_count = used_count + 1 WHERE code = ? AND used_count < max_uses")
                .param(inviteCode)
                .update()
        if (consumed == 0) throw AppException(ErrorCode.INVALID_INVITATION)
        insertAccount(account, passwordHash)
    }

    private fun insertAccount(
        account: Account,
        passwordHash: String,
    ) {
        val inserted =
            jdbc
                .sql(
                    "INSERT INTO accounts (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(username) DO NOTHING",
                ).params(account.id, account.username, passwordHash, account.role.name, Instant.now().toString())
                .update()
        if (inserted == 0) throw AppException(ErrorCode.USERNAME_TAKEN)
    }

    override fun saveSession(
        token: String,
        userId: String,
        expiresAt: Instant,
    ) {
        jdbc.sql("DELETE FROM account_sessions WHERE expires_at <= ?").param(Instant.now().epochSecond).update()
        jdbc
            .sql("INSERT INTO account_sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
            .params(tokenHash(token), userId, expiresAt.epochSecond)
            .update()
    }

    override fun sessionUser(
        token: String,
        now: Instant,
    ): Account? =
        jdbc
            .sql(
                "SELECT a.* FROM account_sessions s JOIN accounts a ON a.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?",
            ).params(tokenHash(token), now.epochSecond)
            .query { rs, _ -> accountOf(rs) }
            .optional()
            .orElse(null)

    override fun deleteSession(token: String) {
        jdbc.sql("DELETE FROM account_sessions WHERE token_hash = ?").param(tokenHash(token)).update()
    }

    override fun listUsers(): List<Account> =
        jdbc
            .sql("SELECT * FROM accounts ORDER BY created_at, id")
            .query { rs, _ -> accountOf(rs) }
            .list()

    override fun createInvitation(
        invitation: Invitation,
        createdBy: String,
    ) {
        jdbc
            .sql("INSERT INTO invitations (code, max_uses, created_by, created_at) VALUES (?, ?, ?, ?)")
            .params(invitation.code, invitation.maxUses, createdBy, Instant.now().toString())
            .update()
    }

    override fun listInvitations(): List<Invitation> =
        jdbc
            .sql("SELECT * FROM invitations ORDER BY created_at DESC, rowid DESC")
            .query { rs, _ -> Invitation(rs.getString("code"), rs.getInt("max_uses"), rs.getInt("used_count")) }
            .list()

    @Transactional
    override fun resetPassword(
        userId: String,
        passwordHash: String,
    ) {
        val updated = jdbc.sql("UPDATE accounts SET password_hash = ? WHERE id = ?").params(passwordHash, userId).update()
        if (updated == 0) throw AppException(ErrorCode.NOT_FOUND, "账号不存在")
        jdbc.sql("DELETE FROM account_sessions WHERE user_id = ?").param(userId).update()
    }

    private fun accountOf(rs: ResultSet) = Account(rs.getString("id"), rs.getString("username"), AccountRole.valueOf(rs.getString("role")))

    private fun tokenHash(token: String): String =
        MessageDigest.getInstance("SHA-256").digest(token.toByteArray()).joinToString("") {
            "%02x".format(it)
        }
}
