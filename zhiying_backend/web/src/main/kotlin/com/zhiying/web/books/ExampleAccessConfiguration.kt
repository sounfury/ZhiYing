// HTTP 权限边界：认证持久会话、阻止跨站写请求，并统一检查书籍归属与管理员入口。
package com.zhiying.web.books

import com.zhiying.application.account.Accounts
import com.zhiying.application.error.AppException
import com.zhiying.application.error.ErrorCode
import com.zhiying.application.library.BookAccess
import com.zhiying.application.library.ExampleBooks
import com.zhiying.domain.library.BookId
import jakarta.servlet.http.HttpServletRequest
import jakarta.servlet.http.HttpServletResponse
import org.springframework.context.annotation.Configuration
import org.springframework.web.servlet.HandlerInterceptor
import org.springframework.web.servlet.HandlerMapping
import org.springframework.web.servlet.config.annotation.InterceptorRegistry
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer

@Configuration(proxyBeanMethods = false)
class ExampleAccessConfiguration(
    private val examples: ExampleBooks,
    private val accounts: Accounts,
    private val books: BookAccess,
) : WebMvcConfigurer {
    override fun addInterceptors(registry: InterceptorRegistry) {
        registry
            .addInterceptor(
                object : HandlerInterceptor {
                    override fun preHandle(
                        request: HttpServletRequest,
                        response: HttpServletResponse,
                        handler: Any,
                    ): Boolean {
                        response.setHeader("Cache-Control", "no-store")
                        if (request.method !in setOf("GET", "HEAD", "OPTIONS") &&
                            request.getHeader("X-Requested-With") != "XMLHttpRequest"
                        ) {
                            throw AppException(ErrorCode.FORBIDDEN, "写请求须由本站发起")
                        }
                        val token = request.cookies?.firstOrNull { it.name == "zhiying_session" }?.value
                        val user = accounts.currentUser(token)
                        if (user != null) request.setAttribute("user", user)
                        val route = request.getAttribute(HandlerMapping.BEST_MATCHING_PATTERN_ATTRIBUTE) as String
                        if (route.startsWith("/api/auth/")) return true
                        if (token != null && user == null) throw AppException(ErrorCode.UNAUTHENTICATED, "登录已过期，请重新登录")
                        if (route.startsWith("/api/admin/") || route.startsWith("/api/eval/") || route.startsWith("/api/diagnostics")) {
                            accounts.requireAdministrator(user)
                            return true
                        }
                        if (route == "/api/feedback") {
                            accounts.requireUser(user)
                            return true
                        }
                        if (route == "/api/me/usage") {
                            accounts.requireUser(user)
                            return true
                        }
                        if (route == "/api/books" && request.method in setOf("GET", "HEAD")) return true
                        if (route == "/api/books/upload") {
                            accounts.requireUser(user)
                            return true
                        }
                        @Suppress("UNCHECKED_CAST")
                        val variables = request.getAttribute(HandlerMapping.URI_TEMPLATE_VARIABLES_ATTRIBUTE) as Map<String, String>
                        val id = variables["bookId"]?.let(::BookId) ?: throw AppException(ErrorCode.NOT_FOUND)
                        val suffix = route.removePrefix("/api/books/{bookId}")
                        if (suffix == "/feedback") {
                            accounts.requireUser(user)
                            books.requireRead(user, id)
                        } else if (request.method in setOf("GET", "HEAD")) {
                            if (suffix !in READ_ROUTES || !examples.isPublished(id)) {
                                if (examples.slug(id) != null) accounts.requireAdministrator(user)
                                books.requireOwner(user, id)
                            }
                        } else {
                            books.requireWrite(user, id)
                        }
                        return true
                    }
                },
            ).addPathPatterns("/api/**")
    }

    private companion object {
        val READ_ROUTES =
            setOf(
                "",
                "/chapters",
                "/graph",
                "/export",
                "/cast",
                "/cast/{personId}",
                "/relation-types",
                "/factions",
                "/factions/{factionId}",
                "/chapters/{cid}/result",
            )
    }
}
