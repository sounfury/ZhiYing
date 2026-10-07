// 持久化基础配置：建立指向本地 SQLite 文件的数据源；各模块的表结构见 resources/schema/*.sql。
package com.zhiying.infrastructure.persistence

import com.zaxxer.hikari.HikariDataSource
import com.zhiying.infrastructure.config.ZhiYingProperties
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import java.nio.file.Files
import javax.sql.DataSource

/**
 * SQLite 数据源。
 *
 * SQLite 不会自动创建目录，因此在建立数据源前创建数据目录；连接统一开启外键约束、WAL 日志与忙等待，
 * 写事务需短小（模型调用不能持有事务）。JdbcClient 由 Spring Boot 基于本数据源自动装配。
 */
@Configuration(proxyBeanMethods = false)
class PersistenceConfiguration {

    /** 创建数据目录与书籍目录，返回连接池化的 SQLite 数据源。 */
    @Bean
    fun dataSource(properties: ZhiYingProperties): DataSource {
        val storage = properties.storage
        Files.createDirectories(storage.booksDir)
        return HikariDataSource().apply {
            jdbcUrl = "jdbc:sqlite:${storage.databaseFile.toAbsolutePath()}"
            addDataSourceProperty("foreign_keys", "true")
            addDataSourceProperty("journal_mode", "WAL")
            addDataSourceProperty("busy_timeout", "5000")
            poolName = "zhiying-sqlite"
        }
    }
}
