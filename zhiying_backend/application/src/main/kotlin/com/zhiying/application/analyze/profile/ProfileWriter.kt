// 全书简介端口：把重要人物各章的简介与提及依据交给模型，换回一段概括全书经历的简介（结构化输出，有界小批，不读原文）。
package com.zhiying.application.analyze.profile

import com.zhiying.application.llm.ModelCallControl
import com.zhiying.domain.identity.Person
import com.zhiying.domain.identity.PersonId
import com.zhiying.domain.library.ChapterId

/**
 * 某人物在一章里的材料：该章身份主张里的简介（可能为空）与该章提及的称呼依据（已去重、已按条数上限截取）。
 * [number] 为章节阅读序号（未知时为 null），提示里用它标注先后。只来自章抽取，不含原文。
 */
data class ChapterMaterial(
    val chapterId: ChapterId,
    val profile: String?,
    val mentionBases: List<String>,
    val number: Int? = null,
) {
    /** 材料的近似输入长度（字符数），用于分批。 */
    val size: Int get() = (profile?.length ?: 0) + mentionBases.sumOf { it.length }
}

/** 一位待写简介的人物：书内人物资料（展示名、别名、性别）与按阅读顺序排列的各章材料。 */
data class ProfileSubject(val person: Person, val chapters: List<ChapterMaterial>) {
    /** 近似输入长度：名称与各章材料的字符数之和。 */
    val size: Int get() = person.names.sumOf { it.length } + chapters.sumOf { it.size }
}

/** 一批全书简介请求；[control] 是任务级预算与取消。 */
data class ProfileRequest(val subjects: List<ProfileSubject>, val control: ModelCallControl = ModelCallControl())

/** 为某个人物写好的全书简介。 */
data class PersonProfile(val person: PersonId, val text: String)

/**
 * 全书简介端口（结构化输出，有界小批，不读原文）。
 *
 * 契约：
 * - 只依据请求里的材料，不用书外知识，不编造；简介要覆盖多章经历，而不只写首次出场；
 * - 只返回有简介的人物，且只能涉及请求内的人物；没有答出的人物视为未回答；
 * - 超时、取消、预算耗尽等执行失败属于执行结果：返回空列表，不抛异常，调用方保留原简介。
 */
interface ProfileWriter {
    /** 为一批人物撰写全书简介。 */
    fun write(request: ProfileRequest): List<PersonProfile>
}
