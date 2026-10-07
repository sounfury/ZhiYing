package com.zhiying.domain.relations

import com.zhiying.domain.identity.LocalPersonRef
import com.zhiying.domain.library.ChapterId
import com.zhiying.domain.library.EvidenceRef

/**
 * 两个人物之间的一次实际交流观察。
 *
 * 它是软关系兜底的输入，本身不是关系，也不会自动入账；只在同一章出现不算交流。
 */
data class InteractionObservation(
    val id: InteractionId,
    val participants: Set<LocalPersonRef>,
    val description: String,
    val evidence: EvidenceRef,
) {
    init {
        require(participants.size == 2) { "交流观察必须恰好涉及两个人物" }
        require(participants.all { it.chapterId == evidence.chapterId }) { "交流双方与依据必须属于同一章" }
        require(description.isNotBlank()) { "交流观察必须描述交流内容" }
    }

    /** 观察所在章节。 */
    val chapterId: ChapterId get() = evidence.chapterId
}
