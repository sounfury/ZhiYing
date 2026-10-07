// 领域层：纯 Kotlin，不依赖任何框架、网络、文件或数据库。
plugins {
    `java-library`
    alias(libs.plugins.kotlin.jvm)
}

kotlin {
    jvmToolchain(21)
}
