// 全书简介的 Spring AI 实现：一批人物一次结构化调用，回复按短代号映射回人物，非法项丢弃并记日志。
package com.zhiying.infrastructure.llm.analysis

import com.zhiying.application.analyze.profile.PersonProfile
import com.zhiying.application.analyze.profile.ProfileRequest
import com.zhiying.application.analyze.profile.ProfileWriter
import com.zhiying.domain.identity.PersonId
import com.zhiying.infrastructure.config.ZhiYingProperties
import com.zhiying.infrastructure.llm.StructuredCallExecutor
import com.zhiying.infrastructure.llm.StructuredOutcome
import com.zhiying.infrastructure.llm.ask
import org.slf4j.LoggerFactory
import org.springframework.stereotype.Component

/** 模型回复：每位人物一段简介。 */
internal data class ProfileReply(val profiles: List<ProfileDto> = emptyList())

/** 一位人物的简介，person 为提示里的短代号（P1、P2……）。 */
internal data class ProfileDto(val person: String = "", val profile: String = "")

/**
 * 基于结构化调用的全书简介撰写。
 *
 * 执行失败（取消、预算耗尽、供应商失败、回复无法解析）时返回空列表，调用方保留各人物原简介。
 * 丢弃的非法项：无法对应到本批人物的代号、空白简介、同一人物的重复回答。
 */
@Component
class SpringAiProfileWriter(
    private val executor: StructuredCallExecutor,
    properties: ZhiYingProperties,
) : ProfileWriter {
    private val config = properties.postProcess
    private val log = LoggerFactory.getLogger(SpringAiProfileWriter::class.java)

    /**
     * 为一批人物撰写全书简介。
     * 入参：[request] 人物及其各章材料与任务级控制。出参：通过校验的简介；失败时为空。
     */
    override fun write(request: ProfileRequest): List<PersonProfile> {
        val outcome = executor.ask<ProfileReply>(
            system = ProfilePrompts.SYSTEM,
            user = ProfilePrompts.user(request.subjects),
            model = AnalysisPromptText.modelOf(config.model),
            thinking = config.thinking,
            control = request.control,
        )
        return when (outcome) {
            is StructuredOutcome.Failed -> {
                log.warn("全书简介未完成（{}），{} 位人物保留原简介：{}", outcome.failure, request.subjects.size, outcome.message)
                emptyList()
            }
            is StructuredOutcome.Success -> convert(outcome.value, request)
        }
    }

    /** 回复转领域结果：代号（或完整 ID）解析回人物，空白简介与重复回答丢弃。 */
    private fun convert(reply: ProfileReply, request: ProfileRequest): List<PersonProfile> {
        val refs = ProfilePrompts.refs(request.subjects)
        val answers = linkedMapOf<PersonId, PersonProfile>()
        for (dto in reply.profiles) {
            val person = AnalysisPromptText.resolvePerson(dto.person, refs)
            val text = dto.profile.trim()
            when {
                person == null -> log.warn("丢弃全书简介：未知人物代号「{}」", dto.person)
                text.isEmpty() -> log.warn("丢弃全书简介：{} 的内容为空", dto.person)
                person in answers -> log.warn("丢弃全书简介：{} 重复回答", dto.person)
                else -> answers[person] = PersonProfile(person, text)
            }
        }
        return answers.values.toList()
    }
}
