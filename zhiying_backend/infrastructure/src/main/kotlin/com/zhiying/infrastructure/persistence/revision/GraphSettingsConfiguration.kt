// 出图参数装配：把 zhiying.graph.* 配置组装成应用层自己的设置对象，应用层不依赖配置类。
package com.zhiying.infrastructure.persistence.revision

import com.zhiying.application.graphquery.GraphSettings
import com.zhiying.domain.graph.DisplayScoring
import com.zhiying.infrastructure.config.ZhiYingProperties
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration

/** 出图设置与事务模板的装配。 */
@Configuration(proxyBeanMethods = false)
class GraphSettingsConfiguration {

    /** 由配置构造出图设置；系数不合法时领域对象构造失败，启动即报错。 */
    @Bean
    fun graphSettings(properties: ZhiYingProperties): GraphSettings {
        val graph = properties.graph
        return GraphSettings(
            scoring = DisplayScoring(graph.hardBase, graph.mediumBase, graph.softBase, graph.perChapter, graph.quotedEvidenceBonus),
            defaultMinAppearance = graph.defaultMinAppearance,
        )
    }
}
