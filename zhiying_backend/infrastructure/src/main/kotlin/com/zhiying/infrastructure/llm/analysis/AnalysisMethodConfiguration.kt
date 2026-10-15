// 自动拼接分析调用点的实际模型 ID 与提示版本，生成秒传的方法摘要。
package com.zhiying.infrastructure.llm.analysis

import com.zhiying.application.analyze.run.AnalysisMethod
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import java.security.MessageDigest

@Configuration(proxyBeanMethods = false)
class AnalysisMethodConfiguration {
    @Bean
    fun analysisMethod(): AnalysisMethod =
        AnalysisMethod { models, prompts ->
            val reading = "${models.reading.model}:${models.reading.thinking}"
            val post = "${models.postProcess.model}:${models.postProcess.thinking}"
            val groups = "${models.affiliation.model}:${models.affiliation.thinking}"
            val calls =
                listOf(
                    "reading:$reading:${prompts.version("reading")}",
                    "identity:$post:${prompts.version("identity")}",
                    "types:$post:${prompts.version("types")}",
                    "recheck:$post:${prompts.version("recheck")}",
                    "fallback:$post:${prompts.version("fallback")}",
                    "profile:$post:${prompts.version("profile")}",
                    "affiliations:$groups:${prompts.version("affiliation")}",
                )
            MessageDigest
                .getInstance("SHA-256")
                .digest(calls.joinToString("\n").toByteArray(Charsets.UTF_8))
                .joinToString("") { "%02x".format(it) }
        }
}
