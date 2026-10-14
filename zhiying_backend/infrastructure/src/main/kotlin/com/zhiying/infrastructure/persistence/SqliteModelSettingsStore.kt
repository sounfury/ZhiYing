// 后台模型覆盖配置；不存服务地址、密钥或其他调用参数。
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
            .sql("SELECT call_point, model, thinking FROM model_settings")
            .query { rs, _ ->
                ModelCallPoint.valueOf(rs.getString("call_point")) to
                    ModelSetting(rs.getString("model"), rs.getInt("thinking") != 0)
            }.list()
            .toMap()

    override fun save(
        point: ModelCallPoint,
        setting: ModelSetting,
        userId: String,
    ) {
        jdbc
            .sql(
                """INSERT INTO model_settings (call_point, model, thinking, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(call_point) DO UPDATE SET model = excluded.model, thinking = excluded.thinking,
            updated_at = excluded.updated_at, updated_by = excluded.updated_by""",
            ).params(point.name, setting.model, if (setting.thinking) 1 else 0, Instant.now().toString(), userId)
            .update()
    }

    override fun remove(point: ModelCallPoint) {
        jdbc.sql("DELETE FROM model_settings WHERE call_point = ?").param(point.name).update()
    }
}
