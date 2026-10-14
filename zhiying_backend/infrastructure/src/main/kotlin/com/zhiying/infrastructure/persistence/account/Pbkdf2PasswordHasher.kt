// 密码算法：用每个密码独立的随机盐与 PBKDF2-HMAC-SHA256 保存密码，比较时使用恒定时间摘要比较。
package com.zhiying.infrastructure.persistence.account

import com.zhiying.application.account.PasswordHasher
import org.springframework.stereotype.Component
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.PBEKeySpec

@Component
class Pbkdf2PasswordHasher : PasswordHasher {
    private val random = SecureRandom()
    private val encoder = Base64.getEncoder()
    private val decoder = Base64.getDecoder()

    override fun hash(password: String): String {
        val salt = ByteArray(16).also(random::nextBytes)
        return "600000:${encoder.encodeToString(salt)}:${encoder.encodeToString(derive(password, salt, 600000))}"
    }

    override fun matches(
        password: String,
        hash: String,
    ): Boolean {
        val (iterations, salt, expected) = hash.split(':')
        return MessageDigest.isEqual(decoder.decode(expected), derive(password, decoder.decode(salt), iterations.toInt()))
    }

    private fun derive(
        password: String,
        salt: ByteArray,
        iterations: Int,
    ): ByteArray {
        val spec = PBEKeySpec(password.toCharArray(), salt, iterations, 256)
        return try {
            SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).encoded
        } finally {
            spec.clearPassword()
        }
    }
}
