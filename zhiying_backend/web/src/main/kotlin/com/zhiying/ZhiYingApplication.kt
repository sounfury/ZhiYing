package com.zhiying

import org.springframework.boot.autoconfigure.SpringBootApplication
import org.springframework.boot.runApplication

/** 智影后端启动类。位于根包，组件扫描覆盖 application 与 infrastructure 各层。 */
@SpringBootApplication
class ZhiYingApplication

/** 启动 Spring Boot 应用。 */
fun main(args: Array<String>) {
    runApplication<ZhiYingApplication>(*args)
}
