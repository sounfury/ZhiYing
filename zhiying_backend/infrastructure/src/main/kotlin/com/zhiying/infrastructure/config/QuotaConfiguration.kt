// 配额部署参数装配：保留时区，以 multipart 文件大小作为后台设置的默认值与硬上限。
package com.zhiying.infrastructure.config

import com.zhiying.application.quota.QuotaSettings
import com.zhiying.application.settings.SettingsLimits
import org.springframework.boot.context.properties.bind.Binder
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.core.env.Environment
import org.springframework.util.unit.DataSize

@Configuration(proxyBeanMethods = false)
class QuotaConfiguration {
    @Bean
    fun quotaSettings(properties: ZhiYingProperties): QuotaSettings = QuotaSettings(properties.quota.timeZone)

    @Bean
    fun settingsLimits(environment: Environment): SettingsLimits {
        val binder = Binder.get(environment)
        val hardFileBytes =
            (
                binder
                    .bind("spring.servlet.multipart.max-file-size", DataSize::class.java)
                    .orElse(null) ?: DataSize.ofMegabytes(1)
            ).toBytes()
        val hardRequestBytes =
            (
                binder
                    .bind("spring.servlet.multipart.max-request-size", DataSize::class.java)
                    .orElse(null) ?: DataSize.ofMegabytes(10)
            ).toBytes()
        require(hardRequestBytes < 0 || (hardFileBytes >= 0 && hardRequestBytes > hardFileBytes)) {
            "spring.servlet.multipart.max-request-size 须大于 max-file-size，以容纳表单开销"
        }
        return SettingsLimits(hardFileBytes.coerceAtLeast(0))
    }
}
