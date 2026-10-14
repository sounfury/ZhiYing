// 用量配置装配：把配置转换为领域上限，并校验 multipart 能接受应用允许的文件。
package com.zhiying.infrastructure.config

import com.zhiying.application.quota.QuotaSettings
import com.zhiying.domain.quota.QuotaLimits
import org.springframework.boot.context.properties.bind.Binder
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.core.env.Environment
import org.springframework.util.unit.DataSize

@Configuration(proxyBeanMethods = false)
class QuotaConfiguration {
    @Bean
    fun quotaSettings(
        properties: ZhiYingProperties,
        environment: Environment,
    ): QuotaSettings {
        val q = properties.quota
        val fileBytes = q.maxFileSize.toBytes()
        val binder = Binder.get(environment)
        val hardFileBytes = (binder.bind("spring.servlet.multipart.max-file-size", DataSize::class.java)
            .orElse(null) ?: DataSize.ofMegabytes(1)).toBytes()
        val hardRequestBytes = (binder.bind("spring.servlet.multipart.max-request-size", DataSize::class.java)
            .orElse(null) ?: DataSize.ofMegabytes(10)).toBytes()
        require(hardFileBytes < 0 || (fileBytes > 0 && hardFileBytes >= fileBytes)) {
            "spring.servlet.multipart.max-file-size 须不小于 zhiying.quota.max-file-size；应用不限时 multipart 也须不限"
        }
        require(hardRequestBytes < 0 || (hardFileBytes >= 0 && hardRequestBytes > hardFileBytes)) {
            "spring.servlet.multipart.max-request-size 须大于 max-file-size，以容纳表单开销"
        }
        return QuotaSettings(
            QuotaLimits(q.maxBooks, q.maxAnalysisChars, fileBytes, q.maxConcurrentTasks, q.dailyTokenBudget),
            q.timeZone,
        )
    }
}
