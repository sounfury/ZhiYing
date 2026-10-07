// 后处理上限装配：把 zhiying.post-process.* 组装成应用层自己的 PostProcessLimits，应用层不依赖配置类。
package com.zhiying.infrastructure.llm.analysis

import com.zhiying.application.analyze.BatchLimits
import com.zhiying.application.analyze.PostProcessLimits
import com.zhiying.application.analyze.profile.ProfileLimits
import com.zhiying.application.analyze.relations.RecheckBudget
import com.zhiying.infrastructure.config.ZhiYingProperties
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration

/** 后处理批量与补查上限的装配。 */
@Configuration(proxyBeanMethods = false)
class PostProcessConfiguration {

    /** 由配置构造上限；数值不合法时配置类或 BatchLimits 构造失败，启动即报错。 */
    @Bean
    fun postProcessLimits(properties: ZhiYingProperties): PostProcessLimits {
        val config = properties.postProcess
        return PostProcessLimits(
            identity = BatchLimits(config.identityMaxItems, config.identityMaxChars),
            typeResolution = BatchLimits(config.typeMaxItems, config.typeMaxChars),
            recheck = RecheckBudget(BatchLimits(config.recheckMaxItems, config.recheckMaxChars), config.recheckMaxRequests),
            fallback = BatchLimits(config.fallbackMaxItems, config.fallbackMaxChars),
            coreMinAppearance = config.coreMinAppearance,
            profile = ProfileLimits(
                batch = BatchLimits(config.profileMaxItems, config.profileMaxChars),
                mentionsPerChapter = config.profileMentionsPerChapter,
                maxChaptersPerPerson = config.profileMaxChaptersPerPerson,
                enabled = config.profileEnabled,
            ),
            appellationBridgeLimit = config.appellationBridgeLimit,
        )
    }
}
