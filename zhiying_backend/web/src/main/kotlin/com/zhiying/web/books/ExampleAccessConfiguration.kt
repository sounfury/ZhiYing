// 公开站点的 HTTP 边界：仅允许示例书浏览与导出，维护接口和其他书的数据均不可访问。
package com.zhiying.web.books

import com.zhiying.application.error.AppException
import com.zhiying.application.error.ErrorCode
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
                        val route = request.getAttribute(HandlerMapping.BEST_MATCHING_PATTERN_ATTRIBUTE) as? String ?: return true

                        @Suppress("UNCHECKED_CAST")
                        val variables = request.getAttribute(HandlerMapping.URI_TEMPLATE_VARIABLES_ATTRIBUTE) as? Map<String, String>
                        val id = variables?.get("bookId")?.let(::BookId)
                        if (request.method == "DELETE" && id != null) examples.requireRemovable(id)
                        if (!examples.publicOnly) return true
                        if (request.method != "GET") throw AppException(ErrorCode.READ_ONLY, "当前只开放示例书浏览")
                        if (route == "/api/books") return true
                        val suffix = route.removePrefix("/api/books/{bookId}")
                        if (id == null || suffix !in READ_ROUTES) throw AppException(ErrorCode.NOT_FOUND)
                        examples.requireReadable(id)
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
