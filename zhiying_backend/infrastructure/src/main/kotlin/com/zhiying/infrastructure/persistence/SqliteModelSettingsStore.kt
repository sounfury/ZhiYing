// 模型专用设置存入 app_settings 的 model 组，通用设置列表不暴露这些键。
package com.zhiying.infrastructure.persistence

import com.zhiying.application.llm.ModelCallPoint
import com.zhiying.application.llm.ModelSetting
import com.zhiying.application.llm.ModelSettingsStore
import com.zhiying.application.settings.AppSettings
import com.zhiying.infrastructure.llm.LlmJson
import org.springframework.stereotype.Repository

@Repository
class SqliteModelSettingsStore(
    private val settings: AppSettings,
) : ModelSettingsStore {
    override fun list(): Map<ModelCallPoint, ModelSetting> {
        val stored = settings.list("model")
        return ModelCallPoint.entries
            .mapNotNull { point ->
                stored[point.name]?.let { point to LlmJson.mapper.readValue(it, ModelSetting::class.java) }
            }.toMap()
    }

    override fun save(
        point: ModelCallPoint,
        setting: ModelSetting,
        userId: String,
    ) {
        // label 是计算属性，不属于持久化模型设置。
        val value = LlmJson.write(mapOf("providerId" to setting.providerId, "model" to setting.model, "thinking" to setting.thinking))
        settings.put("model", point.name, value, userId)
    }
}
