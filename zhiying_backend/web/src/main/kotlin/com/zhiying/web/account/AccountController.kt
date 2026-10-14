// 账号 HTTP 接口：注册、登录、当前账号与退出；持久令牌只通过 HttpOnly Cookie 交付浏览器。
package com.zhiying.web.account

import com.zhiying.application.account.Accounts
import com.zhiying.application.account.Login
import com.zhiying.domain.account.Account
import jakarta.servlet.http.HttpServletResponse
import org.springframework.http.HttpHeaders
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseCookie
import org.springframework.web.bind.annotation.CookieValue
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestAttribute
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.ResponseStatus
import org.springframework.web.bind.annotation.RestController
import java.time.Duration

@RestController
@RequestMapping("/api/auth")
class AccountController(
    private val accounts: Accounts,
) {
    @GetMapping("/me")
    fun me(
        @RequestAttribute("user", required = false) user: Account?,
        @CookieValue("zhiying_session", required = false) token: String?,
        response: HttpServletResponse,
    ): Map<String, Account?> {
        if (user == null && token != null) cookie(response, "", Duration.ZERO)
        return mapOf("user" to user)
    }

    @PostMapping("/register")
    fun register(
        @RequestBody body: Registration,
        response: HttpServletResponse,
    ): Map<String, Account> = signedIn(accounts.register(body.username, body.password, body.inviteCode), response)

    @PostMapping("/login")
    fun login(
        @RequestBody body: Credentials,
        response: HttpServletResponse,
    ): Map<String, Account> = signedIn(accounts.login(body.username, body.password), response)

    @PostMapping("/logout")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun logout(
        @CookieValue("zhiying_session", required = false) token: String?,
        response: HttpServletResponse,
    ) {
        accounts.logout(token)
        cookie(response, "", Duration.ZERO)
    }

    private fun signedIn(
        login: Login,
        response: HttpServletResponse,
    ): Map<String, Account> {
        cookie(response, login.token, accounts.settings.sessionLifetime)
        return mapOf("user" to login.user)
    }

    private fun cookie(
        response: HttpServletResponse,
        token: String,
        lifetime: Duration,
    ) {
        response.addHeader(
            HttpHeaders.SET_COOKIE,
            ResponseCookie
                .from("zhiying_session", token)
                .httpOnly(true)
                .secure(accounts.settings.secureCookie)
                .sameSite("Lax")
                .path("/")
                .maxAge(lifetime)
                .build()
                .toString(),
        )
    }
}

data class Credentials(
    val username: String,
    val password: String,
)

data class Registration(
    val username: String,
    val password: String,
    val inviteCode: String,
)
