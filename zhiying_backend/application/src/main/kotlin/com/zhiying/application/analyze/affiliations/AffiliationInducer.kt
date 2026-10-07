// 团体归纳端口：全书级一次归纳（人名册、按章出场、章摘要、章内观察、关系骨架 → 团体与成员归属）；由基础设施用模型实现。
package com.zhiying.application.analyze.affiliations

import com.zhiying.application.llm.ModelCallControl
import com.zhiying.domain.identity.Person
import com.zhiying.domain.identity.PersonId
import com.zhiying.domain.library.ChapterId

/** 名册中的一个人物：[appearances] 为出场章的阅读序号（升序）。 */
data class InductionPerson(val person: Person, val appearances: List<Int>)

/** 一章的归纳输入：阅读序号、章摘要，以及章内与归属相关的观察（如实际交流的描述）。 */
data class InductionChapter(
    val number: Int,
    val chapterId: ChapterId,
    val summary: String,
    val observations: List<String>,
)

/** 关系骨架中的一条：已准入的关系事实，[chapters] 为出现章的阅读序号。 */
data class InductionRelation(val first: PersonId, val second: PersonId, val typeName: String, val chapters: List<Int>)

/**
 * 一次归纳请求，内容已按配置有界裁剪。
 *
 * [forbiddenNames] 是不能当团体名的词（本书关系类型名及同义名）：关系是边，不是团体。
 */
data class AffiliationRequest(
    val persons: List<InductionPerson>,
    val chapters: List<InductionChapter>,
    val relations: List<InductionRelation>,
    val forbiddenNames: Set<String>,
)

/** 模型提出的一个成员：[chapters] 为其在团体中活跃的章；[note] 与 [quote] 是归属依据。 */
data class InducedMember(
    val person: PersonId,
    val role: String?,
    val chapters: List<ChapterId>,
    val note: String?,
    val quote: String?,
)

/** 模型提出的一个团体：只含团体事实，布局用的推断分区不在其中。 */
data class InducedGroup(val name: String, val kind: String, val note: String?, val members: List<InducedMember>)

/** 归纳结果：执行失败是结果而不是异常，调用方据此保持原结果不变。 */
sealed interface InductionResult {
    /** 取得并通过校验的团体。 */
    data class Induced(val groups: List<InducedGroup>) : InductionResult

    /** 执行失败（超时、取消、预算耗尽、回复无法使用）；不伪造任何团体。 */
    data class Failed(val message: String) : InductionResult
}

/**
 * 团体归纳端口（结构化输出）。
 *
 * 契约：团体是学校、机构、家族、生活圈等因共同归属形成的人群，不是两人之间的关系；
 * 成员只能来自 [AffiliationRequest.persons]，团体名不得出现在 [AffiliationRequest.forbiddenNames]；
 * 只写有依据的归属，不为布局或覆盖率编造。
 */
interface AffiliationInducer {
    /** 执行归纳；任何执行失败都以 [InductionResult.Failed] 返回，不抛异常。 */
    fun induce(request: AffiliationRequest, control: ModelCallControl): InductionResult
}
