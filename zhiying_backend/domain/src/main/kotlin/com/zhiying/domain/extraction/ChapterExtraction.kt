package com.zhiying.domain.extraction

import com.zhiying.domain.identity.IdentityClaim
import com.zhiying.domain.identity.LocalPersonRef
import com.zhiying.domain.identity.PersonMention
import com.zhiying.domain.library.ChapterId
import com.zhiying.domain.library.TextRevision
import com.zhiying.domain.relations.AssessmentSource
import com.zhiying.domain.relations.CandidateId
import com.zhiying.domain.relations.InteractionObservation
import com.zhiying.domain.relations.RelationAssessment
import com.zhiying.domain.relations.RelationCandidate

/** 一次章抽取的身份。 */
@JvmInline
value class ExtractionId(val value: String) {
    init {
        require(value.isNotBlank()) { "抽取 ID 不能为空" }
    }
}

/** 抽取的输入版本：正文修订、模型与提示词版本；任一变化都应产生新的抽取记录，而不是复用旧结果。 */
data class ExtractionProvenance(
    val textRevision: TextRevision,
    val model: String,
    val promptVersion: String,
) {
    init {
        require(model.isNotBlank()) { "必须记录抽取所用模型" }
        require(promptVersion.isNotBlank()) { "必须记录提示词版本" }
    }
}

/** 章摘要：只作后续分析的工作记忆，不作为关系来源。 */
@JvmInline
value class ChapterSummary(val text: String) {
    init {
        require(text.isNotBlank()) { "章摘要不能为空" }
    }
}

/**
 * 一章的一次抽取记录：人物提及与身份主张、明确关系候选及章内首次判断、交流观察和摘要。
 *
 * 已提交的记录不可就地改写：类型归一、补查等后处理各自产生新的判断，重跑产生新的抽取记录。
 * 建立时校验引用完整：候选、交流与身份主张只能指向本章已提及的人物，每条候选恰有一条章内首判。
 */
class ChapterExtraction(
    val id: ExtractionId,
    val chapterId: ChapterId,
    val provenance: ExtractionProvenance,
    val mentions: List<PersonMention>,
    val claims: List<IdentityClaim>,
    val candidates: List<RelationCandidate>,
    val firstAssessments: List<RelationAssessment>,
    val interactions: List<InteractionObservation>,
    val summary: ChapterSummary,
) {
    /** 本章提及的全部局部人物。 */
    val persons: Set<LocalPersonRef> = mentions.mapTo(linkedSetOf()) { it.person }

    init {
        require(persons.all { it.chapterId == chapterId }) { "人物提及必须属于本章" }
        val unknown = referencedPersons() - persons
        require(unknown.isEmpty()) { "引用了本章未提及的人物: ${unknown.map { it.key }}" }
        requireOneFirstAssessmentPerCandidate()
    }

    /** 取某条候选的章内首次判断。 */
    fun firstAssessmentOf(candidate: CandidateId): RelationAssessment =
        firstAssessments.first { it.candidate == candidate }

    /** 候选、交流与身份主张引用到的全部局部人物。 */
    private fun referencedPersons(): Set<LocalPersonRef> =
        candidates.flatMapTo(mutableSetOf()) { listOf(it.source, it.target) } +
            interactions.flatMap { it.participants } +
            claims.map { it.person }

    /** 校验每条候选恰有一条来自读章的首次判断，且没有指向未知候选的判断。 */
    private fun requireOneFirstAssessmentPerCandidate() {
        require(firstAssessments.all { it.source == AssessmentSource.CHAPTER_READING }) { "章内首判只能来自读章" }
        val judged = firstAssessments.map { it.candidate }
        require(judged.size == judged.toSet().size) { "同一候选不能有多条章内首判" }
        require(judged.toSet() == candidates.mapTo(mutableSetOf()) { it.id }) { "每条候选必须恰有一条章内首判" }
    }
}
