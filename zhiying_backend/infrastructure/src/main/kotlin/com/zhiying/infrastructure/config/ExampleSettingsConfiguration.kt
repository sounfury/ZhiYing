// 示例书配置装配：公开模式与固定链接目录集中绑定到 zhiying.examples。
package com.zhiying.infrastructure.config

import com.zhiying.application.library.ExampleSettings
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration

@Configuration(proxyBeanMethods = false)
class ExampleSettingsConfiguration {
    @Bean
    fun exampleSettings(properties: ZhiYingProperties) =
        ExampleSettings(
            properties.examples.publicOnly,
            properties.examples.books,
        )
}
