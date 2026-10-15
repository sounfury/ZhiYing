// 后台模型配置与任务快照：三个分析环节必须显式选择服务商、模型名与思考开关。
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
    val providerId: String,
) {
    /** 来源版本只包含模型名，切换同名模型的服务商不改变版本。 */
    val label: String get() = model
}

data class ModelSnapshot(
    val reading: ModelSetting,
    val postProcess: ModelSetting,
    val affiliation: ModelSetting,
)

data class EffectiveModel(
    val callPoint: ModelCallPoint,
    val providerId: String?,
    val model: String,
    val thinking: Boolean,
    val configured: Boolean,
)

interface ModelSettingsStore {
    fun list(): Map<ModelCallPoint, ModelSetting>

    fun save(
        point: ModelCallPoint,
        setting: ModelSetting,
        userId: String,
    )
}

@Service
class ModelSettings(
    private val store: ModelSettingsStore,
    private val accounts: Accounts,
    private val providers: ModelProviderStore,
) {
    fun current(): List<EffectiveModel> {
        val stored = store.list()
        return ModelCallPoint.entries.map { point ->
            val setting = stored[point]
            val configured = setting != null && setting.model.isNotBlank() && providers.find(setting.providerId) != null
            EffectiveModel(point, setting?.providerId, setting?.model.orEmpty(), setting?.thinking ?: false, configured)
        }
    }

    fun snapshot(): ModelSnapshot {
        val values =
            current().associate { effective ->
                if (!effective.configured) throw AppException(ErrorCode.MODEL_NOT_CONFIGURED)
                effective.callPoint to ModelSetting(effective.model, effective.thinking, requireNotNull(effective.providerId))
            }
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
        if (providerId.isBlank() || model.isBlank()) throw AppException(ErrorCode.INVALID_ARGUMENT, "服务商与模型名必填")
        if (providers.find(providerId) == null) throw AppException(ErrorCode.NOT_FOUND, "服务商不存在")
        store.save(point, ModelSetting(model.trim(), thinking, providerId), user.id)
    }
}
