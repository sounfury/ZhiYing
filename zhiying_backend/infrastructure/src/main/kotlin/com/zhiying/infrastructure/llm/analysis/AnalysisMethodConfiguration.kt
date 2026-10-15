// 自动拼接分析调用点的实际模型 ID 与提示版本，生成秒传的方法摘要。
package com.zhiying.infrastructure.llm.analysis

import com.zhiying.application.analyze.run.AnalysisMethod
import com.zhiying.infrastructure.llm.affiliations.AFFILIATION_PROMPT_VERSION
import com.zhiying.infrastructure.llm.reading.ChapterReadingPrompts
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import java.security.MessageDigest

@Configuration(proxyBeanMethods = false)
class AnalysisMethodConfiguration {
    @Bean
    fun analysisMethod(): AnalysisMethod = AnalysisMethod { models ->
        val reading = "${models.reading.label}:${models.reading.thinking}"
        val post = "${models.postProcess.label}:${models.postProcess.thinking}"
        val groups = "${models.affiliation.label}:${models.affiliation.thinking}"
        val calls =
            listOf(
                "reading:$reading:${ChapterReadingPrompts.VERSION}",
                "identity:$post:${IdentityPrompts.VERSION}",
                "types:$post:${TypeResolutionPrompts.VERSION}",
                "recheck:$post:${RecheckPrompts.VERSION}",
                "fallback:$post:${FallbackPrompts.VERSION}",
                "profile:$post:${ProfilePrompts.VERSION}",
                "affiliations:$groups:$AFFILIATION_PROMPT_VERSION",
            )
        MessageDigest
            .getInstance("SHA-256")
            .digest(calls.joinToString("\n").toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
    }
}
