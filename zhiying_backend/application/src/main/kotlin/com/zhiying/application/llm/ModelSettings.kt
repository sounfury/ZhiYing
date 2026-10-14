// 生效模型配置与任务快照：后台只覆盖模型名和思考开关，连接信息始终由部署配置提供。
package com.zhiying.application.llm

import com.zhiying.application.account.Accounts
import com.zhiying.domain.account.Account
import org.springframework.stereotype.Service

enum class ModelCallPoint { READING, POST_PROCESS, AFFILIATION }

data class ModelSetting(
    val model: String,
    val thinking: Boolean,
)

data class ModelSnapshot(
    val reading: ModelSetting,
    val postProcess: ModelSetting,
    val affiliation: ModelSetting,
)

data class ModelDefaults(
    val defaultModel: String,
    val values: Map<ModelCallPoint, ModelSetting>,
)

data class EffectiveModel(
    val callPoint: ModelCallPoint,
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
) {
    fun current(): List<EffectiveModel> {
        val stored = store.list()
        return ModelCallPoint.entries.map { point ->
            val setting = stored[point] ?: defaults.values.getValue(point)
            EffectiveModel(point, setting.model.ifBlank { defaults.defaultModel }, setting.thinking, if (point in stored) "后台" else "配置文件")
        }
    }

    fun snapshot(): ModelSnapshot {
        val values = current().associate { it.callPoint to ModelSetting(it.model, it.thinking) }
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
        model: String,
        thinking: Boolean,
    ) {
        accounts.requireAdministrator(user)
        store.save(point, ModelSetting(model.trim(), thinking), user.id)
    }

    fun reset(
        user: Account,
        point: ModelCallPoint,
    ) {
        accounts.requireAdministrator(user)
        store.remove(point)
    }
}
