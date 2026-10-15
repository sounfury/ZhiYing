// 后台新增模型服务商的存储：API Key 用 zhiying.llm.secret-key 派生的 AES-GCM 密钥加密，读出明文只供基础设施建连接。
package com.zhiying.infrastructure.persistence

import com.zhiying.application.error.AppException
import com.zhiying.application.error.ErrorCode
import com.zhiying.application.llm.ModelProvider
import com.zhiying.application.llm.ModelProviderStore
import com.zhiying.application.llm.ProviderDraft
import com.zhiying.application.llm.ThinkingStyle
import com.zhiying.infrastructure.config.ZhiYingProperties
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.stereotype.Repository
import java.security.MessageDigest
import java.security.SecureRandom
import java.sql.ResultSet
import java.time.Instant
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/** 建连接所需的服务商信息；[version] 随每次修改变化，供连接缓存判断是否重建。 */
data class ProviderConnection(
    val baseUrl: String,
    val apiKey: String,
    val thinkingStyle: ThinkingStyle,
    val version: String,
)

@Repository
class SqliteModelProviderStore(
    private val jdbc: JdbcClient,
    properties: ZhiYingProperties,
) : ModelProviderStore {
    private val secret = properties.llm.secretKey
    private val random = SecureRandom()

    override fun list(): List<ModelProvider> =
        jdbc.sql("SELECT * FROM model_providers ORDER BY name").query { rs, _ -> provider(rs) }.list()

    override fun find(id: String): ModelProvider? =
        jdbc
            .sql("SELECT * FROM model_providers WHERE id = ?")
            .param(id)
            .query { rs, _ -> provider(rs) }
            .optional()
            .orElse(null)

    /** 解密后的连接信息；服务商不存在返回 null。 */
    fun connection(id: String): ProviderConnection? =
        jdbc
            .sql("SELECT base_url, api_key_cipher, thinking_style, updated_at FROM model_providers WHERE id = ?")
            .param(id)
            .query { rs, _ ->
                ProviderConnection(
                    rs.getString("base_url"),
                    decrypt(rs.getString("api_key_cipher")),
                    ThinkingStyle.valueOf(rs.getString("thinking_style")),
                    rs.getString("updated_at"),
                )
            }.optional()
            .orElse(null)

    override fun save(
        id: String,
        draft: ProviderDraft,
        userId: String,
    ) {
        val now = Instant.now().toString()
        if (draft.apiKey.isBlank()) {
            jdbc
                .sql("UPDATE model_providers SET name = ?, base_url = ?, thinking_style = ?, updated_at = ?, updated_by = ? WHERE id = ?")
                .params(draft.name, draft.baseUrl, draft.thinkingStyle.name, now, userId, id)
                .update()
            return
        }
        jdbc
            .sql(
                """INSERT INTO model_providers (id, name, base_url, api_key_cipher, key_hint, thinking_style, updated_at, updated_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET name = excluded.name, base_url = excluded.base_url, api_key_cipher = excluded.api_key_cipher,
            key_hint = excluded.key_hint, thinking_style = excluded.thinking_style, updated_at = excluded.updated_at, updated_by = excluded.updated_by""",
            ).params(
                id,
                draft.name,
                draft.baseUrl,
                encrypt(draft.apiKey),
                draft.apiKey.takeLast(HINT_CHARS),
                draft.thinkingStyle.name,
                now,
                userId,
            ).update()
    }

    override fun delete(id: String) {
        jdbc.sql("DELETE FROM model_providers WHERE id = ?").param(id).update()
    }

    private fun provider(rs: ResultSet) =
        ModelProvider(
            rs.getString("id"),
            rs.getString("name"),
            rs.getString("base_url"),
            ThinkingStyle.valueOf(rs.getString("thinking_style")),
            rs.getString("key_hint"),
        )

    /** 密文格式：Base64(12 字节 IV + GCM 密文)。 */
    private fun encrypt(plain: String): String {
        val iv = ByteArray(IV_BYTES).also(random::nextBytes)
        val cipher = cipher(Cipher.ENCRYPT_MODE, iv)
        return Base64.getEncoder().encodeToString(iv + cipher.doFinal(plain.toByteArray(Charsets.UTF_8)))
    }

    private fun decrypt(stored: String): String {
        val bytes = Base64.getDecoder().decode(stored)
        return try {
            String(cipher(Cipher.DECRYPT_MODE, bytes.copyOf(IV_BYTES)).doFinal(bytes, IV_BYTES, bytes.size - IV_BYTES), Charsets.UTF_8)
        } catch (e: javax.crypto.AEADBadTagException) {
            throw AppException(ErrorCode.INVALID_ARGUMENT, "服务商密钥无法解密（主密钥已更换），请在后台重新填写", e)
        }
    }

    private fun cipher(
        mode: Int,
        iv: ByteArray,
    ): Cipher {
        if (secret.isBlank()) throw AppException(ErrorCode.INVALID_ARGUMENT, "未配置 LLM_SECRET_KEY，不能保存或使用后台服务商密钥")
        val key = SecretKeySpec(MessageDigest.getInstance("SHA-256").digest(secret.toByteArray(Charsets.UTF_8)), "AES")
        return Cipher.getInstance("AES/GCM/NoPadding").apply { init(mode, key, GCMParameterSpec(TAG_BITS, iv)) }
    }

    private companion object {
        const val IV_BYTES = 12
        const val TAG_BITS = 128
        const val HINT_CHARS = 4
    }
}
