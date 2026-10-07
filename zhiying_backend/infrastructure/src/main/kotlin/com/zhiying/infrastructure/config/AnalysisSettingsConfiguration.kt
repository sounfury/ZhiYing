// 整书分析参数装配：把 zhiying.analysis.* 与 zhiying.reading.segment-* 组装成应用层自己的设置对象，应用层不依赖配置类。
package com.zhiying.infrastructure.config

import com.zhiying.application.analyze.run.AnalysisSettings
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration

/** 分析编排设置的装配。 */
@Configuration(proxyBeanMethods = false)
class AnalysisSettingsConfiguration {

    /** 由配置构造分析设置；取值不合法时启动即报错。 */
    @Bean
    fun analysisSettings(properties: ZhiYingProperties): AnalysisSettings = AnalysisSettings(
        concurrency = properties.analysis.concurrency,
        unitMaxChars = properties.reading.segmentMaxChars,
        maxRequests = properties.analysis.maxRequests,
        maxTokens = properties.analysis.maxTokens,
    )
}
