// 七处系统提示的默认定义与任务快照；覆盖文本按内容定版，参数仅在快照内渲染。
package com.zhiying.application.llm

import java.security.MessageDigest

data class PromptDefinition(
    val text: String,
    val version: String,
)

interface PromptDefaults {
    fun values(): Map<String, PromptDefinition>

    fun parameters(): Map<String, Long>
}

class PromptSnapshot(
    defaults: Map<String, PromptDefinition>,
    overrides: Map<String, String> = emptyMap(),
    defaultParameters: Map<String, Long>,
    parameterOverrides: Map<String, Long> = emptyMap(),
) {
    private val parameters = defaultParameters + parameterOverrides
    private val prompts =
        defaults.mapValues { (key, default) ->
            val base = overrides[key]?.let { text -> PromptDefinition(text, "custom:${hash(text)}") } ?: default
            val keys = when (key) {
                "reading" -> listOf("read_window_chars")
                "affiliation" -> listOf("min_groups", "max_groups")
                else -> emptyList()
            }
            if (keys.any { parameters.getValue(it) != defaultParameters.getValue(it) }) {
                val values = keys.joinToString("\n") { "$it=${parameters.getValue(it)}" }
                PromptDefinition(base.text, "${base.version}/params:${hash(values)}")
            } else {
                base
            }
        }

    fun version(key: String): String = prompts.getValue(key).version

    fun parameter(key: String): Long = parameters.getValue(key)

    fun system(key: String): String =
        PLACEHOLDER.replace(prompts.getValue(key).text) { match -> parameters.getValue(match.groupValues[1]).toString() }

    private fun hash(value: String): String =
        MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }

    private companion object {
        val PLACEHOLDER = Regex("\\{\\{([^{}]+)}}")
    }
}
