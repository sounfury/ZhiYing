// 生效模型配置与任务快照：后台为每个分析环节选服务商、模型名与思考开关；连接信息见 ModelProviders。
package com.zhiying.application.llm

import com.zhiying.application.account.Accounts
import com.zhiying.application.error.AppException
import com.zhiying.application.error.ErrorCode
import com.zhiying.domain.account.Account
import org.springframework.stereotype.Service

enum class ModelCallPoint { READING, POST_PROCESS, AFFILIATION }

data class ModelSetting(
    val model: String,
    val thinking: Boolean,
    val providerId: String = DEFAULT_PROVIDER,
) {
    /** 写入抽取来源与方法版本的模型标识；内置服务商只写模型名，保持已有结果可沿用。 */
    val label: String get() = if (providerId == DEFAULT_PROVIDER) model else "$providerId/$model"
}

data class ModelSnapshot(
    val reading: ModelSetting,
    val postProcess: ModelSetting,
    val affiliation: ModelSetting,
)

data class ModelDefaults(
    val defaultModel: String,
    val values: Map<ModelCallPoint, ModelSetting>,
    val provider: ModelProvider,
)

data class EffectiveModel(
    val callPoint: ModelCallPoint,
    val providerId: String,
    val model: String,
    val thinking: Boolean,
    val source: String,
)

interface ModelSettingsStore {
    fun list(): Map<ModelCallPoint, ModelSetting>

    fun save(
        point: ModelCallPoint,
        setting: ModelSetting,
        userId: String,
    )

    fun remove(point: ModelCallPoint)
}

@Service
class ModelSettings(
    private val store: ModelSettingsStore,
    private val defaults: ModelDefaults,
    private val accounts: Accounts,
    private val providers: ModelProviderStore,
) {
    fun current(): List<EffectiveModel> {
        val stored = store.list()
        return ModelCallPoint.entries.map { point ->
            val setting = stored[point] ?: defaults.values.getValue(point)
            EffectiveModel(point, setting.providerId, setting.model.ifBlank { defaults.defaultModel }, setting.thinking, if (point in stored) "后台" else "配置文件")
        }
    }

    fun snapshot(): ModelSnapshot {
        val values = current().associate { it.callPoint to ModelSetting(it.model, it.thinking, it.providerId) }
        return ModelSnapshot(
            values.getValue(ModelCallPoint.READING),
            values.getValue(ModelCallPoint.POST_PROCESS),
            values.getValue(ModelCallPoint.AFFILIATION),
        )
    }

    fun list(user: Account): List<EffectiveModel> {
        accounts.requireAdministrator(user)
        return current()
    }

    fun save(
        user: Account,
        point: ModelCallPoint,
        providerId: String,
        model: String,
        thinking: Boolean,
    ) {
        accounts.requireAdministrator(user)
        if (providerId != DEFAULT_PROVIDER && providers.find(providerId) == null) throw AppException(ErrorCode.NOT_FOUND, "服务商不存在")
        if (providerId != DEFAULT_PROVIDER && model.isBlank()) throw AppException(ErrorCode.INVALID_ARGUMENT, "非内置服务商需填写模型名")
        store.save(point, ModelSetting(model.trim(), thinking, providerId), user.id)
    }

    fun reset(
        user: Account,
        point: ModelCallPoint,
    ) {
        accounts.requireAdministrator(user)
        store.remove(point)
    }
}
