// SQLite 通用设置存储：按分组与键保存覆盖值和审计信息，按需组装任务提示快照。
package com.zhiying.infrastructure.persistence

import com.zhiying.application.llm.PromptDefaults
import com.zhiying.application.llm.PromptSnapshot
import com.zhiying.application.settings.AppSettings
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.stereotype.Repository
import org.springframework.transaction.annotation.Transactional
import tools.jackson.databind.ObjectMapper
import java.time.Instant

@Repository
class SqliteAppSettings(
    private val jdbc: JdbcClient,
    private val mapper: ObjectMapper,
    private val defaults: PromptDefaults,
) : AppSettings {
    override fun get(
        group: String,
        key: String,
    ): String? =
        jdbc
            .sql("SELECT value_json FROM app_settings WHERE setting_group = ? AND setting_key = ?")
            .params(group, key)
            .query(String::class.java)
            .optional()
            .orElse(null)

    override fun list(group: String): Map<String, String> =
        jdbc
            .sql("SELECT setting_key, value_json FROM app_settings WHERE setting_group = ?")
            .param(group)
            .query { rs, _ -> rs.getString("setting_key") to rs.getString("value_json") }
            .list()
            .toMap()

    override fun put(
        group: String,
        key: String,
        valueJson: String,
        userId: String,
    ) {
        jdbc
            .sql(
                """INSERT INTO app_settings (setting_group, setting_key, value_json, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(setting_group, setting_key) DO UPDATE SET value_json = excluded.value_json,
            updated_at = excluded.updated_at, updated_by = excluded.updated_by""",
            ).params(group, key, valueJson, Instant.now().toString(), userId)
            .update()
    }

    override fun delete(
        group: String,
        key: String,
    ) {
        jdbc.sql("DELETE FROM app_settings WHERE setting_group = ? AND setting_key = ?").params(group, key).update()
    }

    @Transactional(readOnly = true)
    override fun promptSnapshot(): PromptSnapshot {
        val builtIns = defaults.values()
        val overrides = list("prompt").filterKeys { it in builtIns }.mapValues { (_, value) -> mapper.readValue(value, String::class.java) }
        val parameters = list("params").mapValues { (_, value) -> mapper.readValue(value, Long::class.java) }
        return PromptSnapshot(builtIns, overrides, defaults.parameters(), parameters)
    }
}
