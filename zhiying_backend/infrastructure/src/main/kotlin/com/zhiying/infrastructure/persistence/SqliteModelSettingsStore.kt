// 后台模型覆盖配置：每个分析环节的服务商 ID、模型名与思考开关；连接信息在 model_providers。
package com.zhiying.infrastructure.persistence

import com.zhiying.application.llm.ModelCallPoint
import com.zhiying.application.llm.ModelSetting
import com.zhiying.application.llm.ModelSettingsStore
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.stereotype.Repository
import java.time.Instant

@Repository
class SqliteModelSettingsStore(
    private val jdbc: JdbcClient,
) : ModelSettingsStore {
    override fun list(): Map<ModelCallPoint, ModelSetting> =
        jdbc
            .sql("SELECT call_point, provider_id, model, thinking FROM model_settings")
            .query { rs, _ ->
                ModelCallPoint.valueOf(rs.getString("call_point")) to
                    ModelSetting(rs.getString("model"), rs.getInt("thinking") != 0, rs.getString("provider_id"))
            }.list()
            .toMap()

    override fun save(
        point: ModelCallPoint,
        setting: ModelSetting,
        userId: String,
    ) {
        jdbc
            .sql(
                """INSERT INTO model_settings (call_point, provider_id, model, thinking, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(call_point) DO UPDATE SET provider_id = excluded.provider_id, model = excluded.model, thinking = excluded.thinking,
            updated_at = excluded.updated_at, updated_by = excluded.updated_by""",
            ).params(point.name, setting.providerId, setting.model, if (setting.thinking) 1 else 0, Instant.now().toString(), userId)
            .update()
    }

    override fun remove(point: ModelCallPoint) {
        jdbc.sql("DELETE FROM model_settings WHERE call_point = ?").param(point.name).update()
    }
}
