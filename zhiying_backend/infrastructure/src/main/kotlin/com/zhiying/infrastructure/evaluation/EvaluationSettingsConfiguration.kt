// 评测设置装配：把读章所用模型名组装成应用层的 EvaluationSettings，记进每次运行记录。
package com.zhiying.infrastructure.evaluation

import com.zhiying.application.evaluation.EvaluationSettings
import com.zhiying.infrastructure.config.ZhiYingProperties
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration

/** 评测设置的装配。 */
@Configuration(proxyBeanMethods = false)
class EvaluationSettingsConfiguration {

    /** 读章模型留空时用默认模型，与读章实际使用的一致。 */
    @Bean
    fun evaluationSettings(properties: ZhiYingProperties) =
        EvaluationSettings(model = properties.reading.model.ifBlank { properties.llm.model })
}
