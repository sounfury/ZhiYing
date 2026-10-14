// 账号配置装配与首次启动：创建管理员，并将已有无归属测试书归入该账号。
package com.zhiying.infrastructure.config

import com.zhiying.application.account.AccountSettings
import com.zhiying.application.account.Accounts
import org.springframework.boot.ApplicationRunner
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration

@Configuration(proxyBeanMethods = false)
class AccountConfiguration {
    @Bean
    fun accountSettings(properties: ZhiYingProperties) =
        AccountSettings(
            properties.accounts.sessionLifetime,
            properties.accounts.secureCookie,
        )

    @Bean
    fun accountBootstrap(
        accounts: Accounts,
        properties: ZhiYingProperties,
    ) = ApplicationRunner {
        accounts.initializeAdministrator(properties.accounts.adminUsername, properties.accounts.adminPassword)
    }
}
