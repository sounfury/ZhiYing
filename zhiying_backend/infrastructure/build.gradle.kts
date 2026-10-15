// 基础设施层：模型、存储、EPUB 等外部技术，实现应用层定义的接口；不自行决定业务规则。
plugins {
    `java-library`
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.kotlin.spring)
}

kotlin {
    jvmToolchain(21)
    compilerOptions {
        freeCompilerArgs.add("-Xjsr305=strict")
    }
}

dependencies {
    implementation(project(":application"))
    implementation(platform(libs.spring.boot.bom))
    implementation(platform(libs.spring.ai.bom))
    // 直接使用已在原 starter 中的协议客户端，模型连接由后台配置创建。
    implementation(libs.spring.ai.openai)
    implementation(libs.jackson.module.kotlin)
    // 持久化：SQLite + Spring JdbcClient，不引入 ORM
    implementation(libs.spring.boot.starter.jdbc)
    implementation(libs.sqlite.jdbc)
    // EPUB 内的 XHTML 解析
    implementation(libs.jsoup)
}
