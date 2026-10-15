// 模型服务商管理：内置服务商来自部署配置，管理员可新增 OpenAI 兼容服务商；密钥只写不读，列表只给末尾几位。
package com.zhiying.application.llm

import com.zhiying.application.account.Accounts
import com.zhiying.application.error.AppException
import com.zhiying.application.error.ErrorCode
import com.zhiying.domain.account.Account
import org.springframework.stereotype.Service
import java.util.UUID

/** 内置服务商 ID，连接信息来自 `zhiying.llm.*`。 */
const val DEFAULT_PROVIDER = "default"

/** 服务商开关思考模式的请求参数写法。 */
enum class ThinkingStyle {
    /** DeepSeek：`thinking: {type: enabled|disabled}`。 */
    DEEPSEEK,

    /** 通义、硅基流动、vLLM 等：`enable_thinking: true|false`。 */
    ENABLE_THINKING,

    /** 不支持开关，不发送思考参数。 */
    NONE,
}

/** 后台可见的服务商信息；不含密钥明文。 */
data class ModelProvider(
    val id: String,
    val name: String,
    val baseUrl: String,
    val thinkingStyle: ThinkingStyle,
    val keyHint: String,
    val builtIn: Boolean,
)

/** 新增或修改服务商的输入；[apiKey] 为空表示修改时保留原密钥。 */
data class ProviderDraft(
    val name: String,
    val baseUrl: String,
    val apiKey: String,
    val thinkingStyle: ThinkingStyle,
)

/** 管理员新增的服务商存储；实现方负责加密密钥。 */
interface ModelProviderStore {
    fun list(): List<ModelProvider>

    fun find(id: String): ModelProvider?

    /** 保存服务商；[ProviderDraft.apiKey] 为空时保留原密钥。 */
    fun save(
        id: String,
        draft: ProviderDraft,
        userId: String,
    )

    fun delete(id: String)
}

/** 向服务商查询可用模型列表。 */
fun interface ModelCatalog {
    fun models(providerId: String): List<String>
}

@Service
class ModelProviders(
    private val store: ModelProviderStore,
    private val settings: ModelSettingsStore,
    private val defaults: ModelDefaults,
    private val catalog: ModelCatalog,
    private val accounts: Accounts,
) {
    /** 内置服务商在前，其余按存储顺序。 */
    fun all(): List<ModelProvider> = listOf(defaults.provider) + store.list()

    fun exists(id: String) = id == DEFAULT_PROVIDER || store.find(id) != null

    fun list(user: Account): List<ModelProvider> {
        accounts.requireAdministrator(user)
        return all()
    }

    fun create(
        user: Account,
        draft: ProviderDraft,
    ): String {
        accounts.requireAdministrator(user)
        val clean = validated(draft)
        if (clean.apiKey.isBlank()) throw AppException(ErrorCode.INVALID_ARGUMENT, "请填写 API Key")
        val id = UUID.randomUUID().toString()
        store.save(id, clean, user.id)
        return id
    }

    fun update(
        user: Account,
        id: String,
        draft: ProviderDraft,
    ) {
        accounts.requireAdministrator(user)
        editable(id)
        store.save(id, validated(draft), user.id)
    }

    /** 仍被某个分析环节使用时拒绝删除。 */
    fun delete(
        user: Account,
        id: String,
    ) {
        accounts.requireAdministrator(user)
        editable(id)
        if (settings.list().values.any { it.providerId == id }) {
            throw AppException(ErrorCode.INVALID_ARGUMENT, "该服务商正被分析环节使用，请先改用其他服务商")
        }
        store.delete(id)
    }

    /** 实时向服务商拉取模型列表；失败由实现方转成带原因的错误。 */
    fun models(
        user: Account,
        id: String,
    ): List<String> {
        accounts.requireAdministrator(user)
        if (!exists(id)) throw AppException(ErrorCode.NOT_FOUND)
        return catalog.models(id).sorted()
    }

    private fun editable(id: String) {
        if (id == DEFAULT_PROVIDER) throw AppException(ErrorCode.READ_ONLY, "内置服务商由部署配置提供，不能在后台修改")
        if (store.find(id) == null) throw AppException(ErrorCode.NOT_FOUND)
    }

    private fun validated(draft: ProviderDraft): ProviderDraft {
        val name = draft.name.trim()
        val baseUrl = draft.baseUrl.trim().trimEnd('/')
        if (name.isEmpty() || name.length > MAX_NAME) throw AppException(ErrorCode.INVALID_ARGUMENT, "名称需为 1–$MAX_NAME 字")
        if (!baseUrl.startsWith("https://") && !baseUrl.startsWith("http://")) {
            throw AppException(ErrorCode.INVALID_ARGUMENT, "服务地址需以 http:// 或 https:// 开头")
        }
        return draft.copy(name = name, baseUrl = baseUrl, apiKey = draft.apiKey.trim())
    }

    private companion object {
        const val MAX_NAME = 40
    }
}
