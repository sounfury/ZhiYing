// 团体归纳参数装配：把 zhiying.affiliations.* 配置组装成应用层自己的设置对象，应用层不依赖配置类。
package com.zhiying.infrastructure.llm.affiliations

import com.zhiying.application.analyze.affiliations.AffiliationSettings
import com.zhiying.infrastructure.config.ZhiYingProperties
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration

/** 团体归纳输入裁剪上限的装配。 */
@Configuration(proxyBeanMethods = false)
class AffiliationSettingsConfiguration {

    /** 由配置构造团体归纳设置。 */
    @Bean
    fun affiliationSettings(properties: ZhiYingProperties): AffiliationSettings {
        val a = properties.affiliations
        return AffiliationSettings(
            maxPersons = a.maxPersons,
            maxProfileChars = a.maxProfileChars,
            maxChapters = a.maxChapters,
            maxSummaryChars = a.maxSummaryChars,
            maxObservationsPerChapter = a.maxObservationsPerChapter,
            maxObservationChars = a.maxObservationChars,
            maxRelations = a.maxRelations,
        )
    }
}
