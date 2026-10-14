// 部署模型配置作为后台覆盖值缺省来源；不把连接地址与密钥传入应用层。
package com.zhiying.infrastructure.config

import com.zhiying.application.llm.ModelCallPoint
import com.zhiying.application.llm.ModelDefaults
import com.zhiying.application.llm.ModelSetting
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration

@Configuration(proxyBeanMethods = false)
class ModelSettingsConfiguration {
    @Bean
    fun modelDefaults(properties: ZhiYingProperties) =
        ModelDefaults(
            properties.llm.model,
            mapOf(
                ModelCallPoint.READING to ModelSetting(properties.reading.model, properties.reading.thinking),
                ModelCallPoint.POST_PROCESS to ModelSetting(properties.postProcess.model, properties.postProcess.thinking),
                ModelCallPoint.AFFILIATION to ModelSetting(properties.affiliations.model, properties.affiliations.thinking),
            ),
        )
}
