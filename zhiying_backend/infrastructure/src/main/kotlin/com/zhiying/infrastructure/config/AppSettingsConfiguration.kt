// 设置 JSON 能力装配：将基础设施的序列化器提供给应用层设置用例。
package com.zhiying.infrastructure.config

import com.zhiying.application.settings.SettingsJson
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import tools.jackson.databind.ObjectMapper

@Configuration(proxyBeanMethods = false)
class AppSettingsConfiguration {
    @Bean
    fun settingsJson(mapper: ObjectMapper): SettingsJson =
        object : SettingsJson {
            override fun decode(valueJson: String): Any? = mapper.readValue(valueJson, Any::class.java)

            override fun encode(value: Any): String = mapper.writeValueAsString(value)
        }
}
