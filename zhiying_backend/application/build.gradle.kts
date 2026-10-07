// 应用层：用例编排与外部能力接口。只依赖领域层与 Spring 容器注解，不接触厂商 SDK、SQL 与文件路径。
plugins {
    `java-library`
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.kotlin.spring)
}

kotlin {
    jvmToolchain(21)
}

dependencies {
    api(project(":domain"))
    implementation(platform(libs.spring.boot.bom))
    implementation(libs.spring.context)
}
