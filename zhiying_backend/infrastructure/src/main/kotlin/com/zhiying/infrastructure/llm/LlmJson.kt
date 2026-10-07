// 模型交互用的 JSON 工具：统一的 Jackson 映射器（Kotlin 支持、忽略多余字段）。
package com.zhiying.infrastructure.llm

import tools.jackson.databind.DeserializationFeature
import tools.jackson.databind.PropertyNamingStrategies
import tools.jackson.databind.json.JsonMapper
import tools.jackson.module.kotlin.jacksonMapperBuilder

/** 解析模型回复与工具参数、序列化工具结果共用的映射器；模型多给的字段忽略，不当作错误。 */
internal object LlmJson {
    val mapper: JsonMapper = jacksonMapperBuilder()
        .disable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
        .build()

    /** 解析工具入参用：字段名 snake_case，其余同 [mapper]。 */
    val toolMapper: JsonMapper = jacksonMapperBuilder()
        .disable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
        .propertyNamingStrategy(PropertyNamingStrategies.SNAKE_CASE)
        .build()

    /** 把对象序列化为 JSON 文本，用作工具返回值。 */
    fun write(value: Any): String = mapper.writeValueAsString(value)
}
