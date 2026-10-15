// 按后台服务商构建并缓存对话模型，提供思考参数写法与实时模型列表查询。
package com.zhiying.infrastructure.llm

import com.zhiying.application.error.AppException
import com.zhiying.application.error.ErrorCode
import com.zhiying.application.llm.ModelCatalog
import com.zhiying.application.llm.ThinkingStyle
import com.zhiying.infrastructure.persistence.SqliteModelProviderStore
import org.springframework.ai.chat.model.ChatModel
import org.springframework.ai.openai.OpenAiChatModel
import org.springframework.ai.openai.OpenAiChatOptions
import org.springframework.stereotype.Component
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import java.util.concurrent.ConcurrentHashMap

/** 一个服务商的对话模型与其思考参数写法。 */
class ProviderModel(
    val chatModel: ChatModel,
    val thinkingStyle: ThinkingStyle,
)

@Component
class ProviderChatModels(
    private val store: SqliteModelProviderStore,
) : ModelCatalog {
    private val cache = ConcurrentHashMap<String, Pair<String, ProviderModel>>()
    private val http = HttpClient.newBuilder().connectTimeout(TIMEOUT).build()

    /** 取服务商的对话模型；后台服务商被修改后按新连接重建。服务商不存在抛 NOT_FOUND。 */
    fun of(providerId: String): ProviderModel {
        val connection = store.connection(providerId) ?: throw AppException(ErrorCode.NOT_FOUND, "模型服务商不存在")
        cache[providerId]?.takeIf { it.first == connection.version }?.let { return it.second }
        val options =
            OpenAiChatOptions
                .builder()
                .baseUrl(connection.baseUrl)
                .apiKey(connection.apiKey)
                .maxRetries(0)
                .build()
        val model = ProviderModel(OpenAiChatModel.builder().options(options).build(), connection.thinkingStyle)
        cache[providerId] = connection.version to model
        return model
    }

    /** 按服务商写法生成思考开关的请求体字段。 */
    fun thinkingBody(
        style: ThinkingStyle,
        enabled: Boolean,
    ): Map<String, Any> =
        when (style) {
            ThinkingStyle.DEEPSEEK -> mapOf("thinking" to mapOf("type" to if (enabled) "enabled" else "disabled"))
            ThinkingStyle.ENABLE_THINKING -> mapOf("enable_thinking" to enabled)
            ThinkingStyle.NONE -> emptyMap()
        }

    /** 请求 OpenAI 兼容的 `GET {baseUrl}/models`，返回模型 ID。 */
    override fun models(providerId: String): List<String> {
        val connection = store.connection(providerId) ?: throw AppException(ErrorCode.NOT_FOUND, "模型服务商不存在")
        val baseUrl = connection.baseUrl
        val apiKey = connection.apiKey
        val request =
            HttpRequest
                .newBuilder(URI.create(baseUrl.trimEnd('/') + "/models"))
                .header("Authorization", "Bearer $apiKey")
                .timeout(TIMEOUT)
                .GET()
                .build()
        val response =
            try {
                http.send(request, HttpResponse.BodyHandlers.ofString())
            } catch (e: Exception) {
                throw AppException(ErrorCode.INVALID_ARGUMENT, "无法连接服务商，可手动填写模型名", e)
            }
        if (response.statusCode() != HTTP_OK) {
            throw AppException(ErrorCode.INVALID_ARGUMENT, "服务商返回 ${response.statusCode()}，可手动填写模型名")
        }
        return LlmJson.mapper
            .readTree(response.body())
            .path("data")
            .mapNotNull { it.path("id").asString(null) }
    }

    private companion object {
        val TIMEOUT: Duration = Duration.ofSeconds(15)
        const val HTTP_OK = 200
    }
}
