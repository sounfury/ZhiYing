// 汇集七处内置系统提示与原版本常量，供后台默认值及任务快照使用。
package com.zhiying.infrastructure.llm.analysis

import com.zhiying.application.llm.PromptDefaults
import com.zhiying.application.llm.PromptDefinition
import com.zhiying.infrastructure.config.ZhiYingProperties
import com.zhiying.infrastructure.llm.affiliations.AFFILIATION_PROMPT_VERSION
import com.zhiying.infrastructure.llm.affiliations.AffiliationPrompts
import com.zhiying.infrastructure.llm.reading.ChapterReadingPrompts
import org.springframework.stereotype.Component

@Component
class BuiltInPromptDefaults(private val properties: ZhiYingProperties) : PromptDefaults {
    override fun parameters(): Map<String, Long> =
        mapOf(
            "read_window_chars" to properties.reading.readWindowChars.toLong(),
            "min_groups" to properties.affiliations.minGroups.toLong(),
            "max_groups" to properties.affiliations.maxGroups.toLong(),
        )

    override fun values(): Map<String, PromptDefinition> =
        mapOf(
            "reading" to PromptDefinition(ChapterReadingPrompts.SYSTEM, ChapterReadingPrompts.VERSION),
            "identity" to PromptDefinition(IdentityPrompts.SYSTEM, IdentityPrompts.VERSION),
            "types" to PromptDefinition(TypeResolutionPrompts.SYSTEM, TypeResolutionPrompts.VERSION),
            "recheck" to PromptDefinition(RecheckPrompts.SYSTEM, RecheckPrompts.VERSION),
            "fallback" to PromptDefinition(FallbackPrompts.SYSTEM, FallbackPrompts.VERSION),
            "profile" to PromptDefinition(ProfilePrompts.SYSTEM, ProfilePrompts.VERSION),
            "affiliation" to PromptDefinition(AffiliationPrompts.SYSTEM, AFFILIATION_PROMPT_VERSION),
        )
}
