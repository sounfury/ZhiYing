// Web 层：Spring Boot 启动、HTTP 路由与响应 DTO。
plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.kotlin.spring)
    alias(libs.plugins.spring.boot)
}

kotlin {
    jvmToolchain(21)
    compilerOptions {
        freeCompilerArgs.add("-Xjsr305=strict")
    }
}

dependencies {
    implementation(project(":application"))
    // 基础设施只在运行时装配：web 代码编译期看不到模型、存储实现，只能经应用层调用
    runtimeOnly(project(":infrastructure"))
    implementation(platform(libs.spring.boot.bom))
    implementation(libs.spring.boot.starter.webmvc)
    implementation(libs.jackson.module.kotlin)
    implementation(libs.kotlin.reflect)
}

tasks.bootRun {
    // 从工程根目录启动，才能读取根目录下的 .env
    workingDir = rootDir
}
