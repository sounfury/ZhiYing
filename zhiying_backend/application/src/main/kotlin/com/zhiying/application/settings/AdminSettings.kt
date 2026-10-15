// 后台设置用例：声明通用可配置项、校验管理员修改，并为每次配额检查读取当前生效上限。
package com.zhiying.application.settings

import com.zhiying.application.account.Accounts
import com.zhiying.application.error.AppException
import com.zhiying.application.error.ErrorCode
import com.zhiying.application.llm.PromptDefaults
import com.zhiying.domain.account.Account
import com.zhiying.domain.quota.QuotaLimits
import org.springframework.stereotype.Service

/** JSON 编解码交由基础设施，应用层只处理数字和字符串。 */
interface SettingsJson {
    fun decode(valueJson: String): Any?

    fun encode(value: Any): String
}

data class SettingsLimits(val maxFileBytes: Long)

private data class SettingDefinition(
    val key: String,
    val label: String,
    val type: String,
    val hint: String,
    val placeholders: Map<String, String> = emptyMap(),
)

@Service
class AdminSettings(
    private val accounts: Accounts,
    private val store: AppSettings,
    private val defaults: PromptDefaults,
    private val limits: SettingsLimits,
    private val json: SettingsJson,
) {
    private val quota = listOf(
        SettingDefinition("max_books", "每人书数", "count", "不含示例书，0 表示不限"),
        SettingDefinition("max_tokens", "每人累计 token", "count", "普通用户累计消耗的 token，邀请码可单独指定；0 表示不限"),
        SettingDefinition("max_analysis_chars", "每人累计分析字数", "count", "包含正在分析的预占字数，0 表示不限"),
        SettingDefinition("max_file_size", "单个上传文件大小", "bytes", "单位为字节，不得超过部署硬上限"),
        SettingDefinition("max_concurrent_tasks", "每人同时运行任务数", "count", "整书分析与单章重跑合计，0 表示不限"),
        SettingDefinition("daily_token_budget", "全站每日 token", "count", "按部署时区计算，0 表示不限"),
    )
    private val prompt = listOf(
        SettingDefinition("reading", "章节阅读", "prompt", "章节阅读系统提示", mapOf("read_window_chars" to "每次读取的最大字数")),
        SettingDefinition("identity", "人物身份核对", "prompt", "人物身份核对系统提示"),
        SettingDefinition("types", "关系类型归并", "prompt", "关系类型归并系统提示"),
        SettingDefinition("recheck", "关系复核", "prompt", "关系复核系统提示"),
        SettingDefinition("fallback", "关系回退归类", "prompt", "关系回退归类系统提示"),
        SettingDefinition("profile", "人物资料归纳", "prompt", "人物资料归纳系统提示"),
        SettingDefinition("affiliation", "团体归纳", "prompt", "团体归纳系统提示", mapOf("min_groups" to "建议最少团体数", "max_groups" to "建议最多团体数")),
    )
    private val params = listOf(
        SettingDefinition("read_window_chars", "每窗读取字数", "count", "章节阅读提示参数，同时是长章分段读取的实际每窗最大字数"),
        SettingDefinition("min_groups", "建议最少团体数", "count", "团体归纳提示中建议的最少团体数，不得大于建议最多团体数"),
        SettingDefinition("max_groups", "建议最多团体数", "count", "团体归纳提示中建议的最多团体数，不得小于建议最少团体数"),
    )
    private val groups = linkedMapOf("quota" to quota, "params" to params, "prompt" to prompt)
    private val placeholders = Regex("\\{\\{(.*?)\\}\\}", RegexOption.DOT_MATCHES_ALL)

    fun list(user: Account): List<Map<String, Any>> {
        accounts.requireAdministrator(user)
        return groups.map { (group, definitions) ->
            val overrides = store.list(group)
            mapOf(
                "group" to group,
                "label" to when (group) {
                    "quota" -> "用量上限"
                    "params" -> "提示词参数"
                    else -> "系统提示词"
                },
                "items" to definitions.map { definition ->
                    val defaultValue = defaultValue(group, definition.key)
                    buildMap<String, Any> {
                        put("key", definition.key)
                        put("label", definition.label)
                        put("type", definition.type)
                        put("value", overrides[definition.key]?.let { json.decode(it) } ?: defaultValue)
                        put("defaultValue", defaultValue)
                        put("overridden", overrides.containsKey(definition.key))
                        put("hint", definition.hint)
                        if (group == "params") put("min", 1)
                        if (definition.type == "bytes") put("max", limits.maxFileBytes)
                        if (definition.type == "prompt") {
                            put("placeholders", definition.placeholders.map { (name, description) -> mapOf("name" to name, "description" to description) })
                        }
                    }
                },
            )
        }
    }

    @Synchronized
    fun save(user: Account, group: String, key: String, value: Any?) {
        accounts.requireAdministrator(user)
        val definition = definition(group, key)
        val normalized = if (definition.type == "prompt") {
            val text = value as? String ?: invalid("提示词必须是文本")
            if (text.isBlank()) invalid("提示词不能为空")
            if (placeholders.findAll(text).any { it.groupValues[1] !in definition.placeholders }) {
                invalid("提示词包含未知占位符")
            }
            text
        } else {
            val number = when (value) {
                is Byte, is Short, is Int, is Long -> (value as Number).toLong()
                else -> invalid(if (group == "params") "提示词参数必须是正整数" else "上限必须是非负整数")
            }
            if (group == "params") validateParameter(key, number) else if (number < 0) invalid("上限必须是非负整数")
            if (definition.type == "bytes" && limits.maxFileBytes > 0 && (number == 0L || number > limits.maxFileBytes)) {
                invalid("文件大小必须为 1～${limits.maxFileBytes} 字节")
            }
            number
        }
        store.put(group, key, json.encode(normalized), user.id)
    }

    @Synchronized
    fun reset(user: Account, group: String, key: String) {
        accounts.requireAdministrator(user)
        definition(group, key)
        if (group == "params") validateParameter(key, defaultValue(group, key) as Long)
        store.delete(group, key)
    }

    private fun validateParameter(key: String, number: Long) {
        if (number < 1) invalid("提示词参数必须是正整数")
        if (key == "read_window_chars" && number > Int.MAX_VALUE) invalid("每窗读取字数不能超过 ${Int.MAX_VALUE}")
        fun current(name: String): Long =
            store.get("params", name)?.let { (json.decode(it) as Number).toLong() } ?: defaults.parameters().getValue(name)
        if ((key == "min_groups" && number > current("max_groups")) ||
            (key == "max_groups" && number < current("min_groups"))
        ) invalid("建议最少团体数不能大于建议最多团体数")
    }

    fun quotaLimits(): QuotaLimits {
        val values = store.list("quota")
        fun value(key: String) = values[key]?.let { (json.decode(it) as Number).toLong() } ?: defaultValue("quota", key) as Long
        return QuotaLimits(value("max_books"), value("max_analysis_chars"), value("max_file_size"), value("max_concurrent_tasks"), value("daily_token_budget"), value("max_tokens"))
    }

    private fun defaultValue(group: String, key: String): Any =
        when {
            group == "prompt" -> defaults.values().getValue(key).text
            group == "params" -> defaults.parameters().getValue(key)
            key == "max_file_size" -> limits.maxFileBytes
            else -> 0L
        }

    private fun definition(group: String, key: String): SettingDefinition =
        groups[group]?.firstOrNull { it.key == key } ?: throw AppException(ErrorCode.NOT_FOUND, "未知设置项")

    private fun invalid(message: String): Nothing = throw AppException(ErrorCode.INVALID_ARGUMENT, message)
}
