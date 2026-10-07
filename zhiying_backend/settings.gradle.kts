// 智影后端：Kotlin/JVM 模块化单体。
// 编译依赖方向：web → application → domain；infrastructure → application → domain；web 仅在运行时装配 infrastructure。
pluginManagement {
    repositories {
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode = RepositoriesMode.FAIL_ON_PROJECT_REPOS
    repositories {
        mavenCentral()
    }
}

rootProject.name = "zhiying-backend"

include("domain", "application", "infrastructure", "web")
