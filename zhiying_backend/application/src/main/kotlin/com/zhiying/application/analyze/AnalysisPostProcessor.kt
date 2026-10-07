// 分析后处理编排：把多章 ChapterExtraction 变成一套一致的 AnalysisRevision。
// 本类不是 Spring Bean：每次分析任务需要自己的取消与预算控制，由 AnalysisPostProcessorFactory 按任务创建。
package com.zhiying.application.analyze

import com.zhiying.application.analyze.identity.IdentityAlignmentStep
import com.zhiying.application.analyze.profile.ProfileStats
import com.zhiying.application.analyze.profile.ProfileStep
import com.zhiying.application.analyze.relations.FallbackStats
import com.zhiying.application.analyze.relations.RecheckStats
import com.zhiying.application.analyze.relations.RelationRecheckStep
import com.zhiying.application.analyze.relations.SoftFallbackStep
import com.zhiying.application.analyze.relations.TypeNormalizationStep
import com.zhiying.domain.affiliations.Affiliations
import com.zhiying.domain.extraction.ChapterExtraction
import com.zhiying.domain.identity.AlignedIdentities
import com.zhiying.domain.identity.Person
import com.zhiying.domain.library.BookId
import com.zhiying.domain.library.ChapterId
import com.zhiying.domain.relations.BuildOutcome
import com.zhiying.domain.relations.BuiltInRelationTypes
import com.zhiying.domain.relations.CandidateRef
import com.zhiying.domain.relations.OccurrenceBuilder
import com.zhiying.domain.relations.PersonPair
import com.zhiying.domain.relations.RelationOccurrence
import com.zhiying.domain.relations.RelationTypeLibrary
import com.zhiying.domain.relations.ResolvedInteraction
import com.zhiying.domain.revision.AnalysisRevision
import com.zhiying.domain.revision.RevisionAssembly
import com.zhiying.domain.revision.RevisionId

/**
 * 后处理输入。
 *
 * [extractions] 各章抽取，须按阅读顺序排列；[roster] 已有人名册（重跑时为上一版人物，保持 ID 稳定）；
 * [retained] 上一版保留的历史软关系，调用方先按"来源章节仍然有效"筛选；
 * [types] 起始类型库（默认仅含内置类型）；[affiliations] 团体结果，后续批次补上前为空；
 * [chapterOrder] 章节阅读序号（从 1 起），写入结果版本供出图排序，缺省时出图按章节 ID 排序；
 * [rerunChapter] 单章重跑时被重跑的章，全书简介只重写在该章出场的重要人物；整书分析为 null。
 */
data class PostProcessInput(
    val bookId: BookId,
    val revisionId: RevisionId,
    val extractions: List<ChapterExtraction>,
    val roster: List<Person> = emptyList(),
    val retained: List<RelationOccurrence> = emptyList(),
    val types: RelationTypeLibrary = BuiltInRelationTypes.library(),
    val affiliations: Affiliations = Affiliations(emptyList(), emptyList()),
    val chapterOrder: Map<ChapterId, Int> = emptyMap(),
    val rerunChapter: ChapterId? = null,
)

/**
 * 后处理报告：给诊断与评测使用的过程信息。
 * [unbuilt] 是没能构建成记录的候选（含合并后自环、需要重新处理的）；
 * [identityRejections] 是被程序拒绝的身份结论；[unboundLocals] 是没有可用称呼的局部人物数；[profile] 是全书简介统计。
 */
data class PostProcessReport(
    val unboundLocals: Int,
    val identityRejections: List<String>,
    val unbuilt: List<BuildOutcome.Unbuilt>,
    val recheck: RecheckStats,
    val fallback: FallbackStats,
    val profile: ProfileStats = ProfileStats(),
)

/** 后处理产物：结果版本与报告。 */
data class PostProcessResult(val revision: AnalysisRevision, val report: PostProcessReport)

/**
 * 分析后处理用例（非 Spring Bean，由 [AnalysisPostProcessorFactory] 创建）。
 *
 * 调用顺序即 DESIGN §3 的流程，副作用（模型调用、读原文）都在各步骤里显式发生：
 * 1. 身份对齐：明确绑定直接采用，歧义交给 IdentityDisambiguator，登记合并；
 * 2. 类型归一：名称确定性匹配，剩余交给 RelationTypeResolver（先查类型语义缓存）；
 * 3. 构建关系记录：沿用章内首判，未决 / 否定记录同样保留，自环等标出；
 * 4. 有限补查：只补明确未决的硬 / 中关系（RelationRechecker）；
 * 5. 软兜底：按 §3.5 的表规划并分流，路人对规则贴「相识」，重要对交给 SoftFallbackFinder 查漏
 *    （疑似强关系再补查一轮），软标签由领域校验；
 * 6. 全书简介：为重要人物改写成概括多章经历的简介（失败时保留原简介）；
 * 7. 组装 AnalysisRevision（团体部分用传入值）。
 */
class AnalysisPostProcessor(
    private val identityStep: IdentityAlignmentStep,
    private val typeStep: TypeNormalizationStep,
    private val recheckStep: RelationRecheckStep,
    private val fallbackStep: SoftFallbackStep,
    private val profileStep: ProfileStep,
) {
    /** 执行全部后处理步骤并返回结果版本与报告。 */
    fun process(input: PostProcessInput): PostProcessResult {
        val identities = identityStep.run(input.roster, input.extractions)
        val normalization = typeStep.run(input.types, input.extractions)
        val library = normalization.library

        val (built, unbuilt) = buildOccurrences(input.extractions, identities, normalization.resolutions(), library)
        val persons = identities.persons.associateBy { it.id }
        val rechecked = recheckStep.run(built, library, persons)
        val interactions = resolveInteractions(input.extractions, identities)
        // 历史软关系参与兜底判定：已有成立记录的人物对不再新增软关系
        val retained = input.retained
        val fallback = fallbackStep.run(library, rechecked.occurrences + retained, interactions, persons, identities.appearances)

        val occurrences = rechecked.occurrences + fallback.added
        val profiles = profileStep.run(identities, input.extractions, occurrences, library, input.rerunChapter, input.chapterOrder)

        val revision = RevisionAssembly.assemble(
            id = input.revisionId,
            bookId = input.bookId,
            analyzedChapters = input.extractions.mapTo(linkedSetOf()) { it.chapterId },
            identities = identities.copy(persons = profiles.persons),
            types = library,
            occurrences = occurrences,
            retained = retained,
            affiliations = input.affiliations,
            chapterOrder = input.chapterOrder,
        )
        val report = PostProcessReport(identities.unbound.size, identities.rejections, unbuilt, rechecked.stats, fallback.stats, profiles.stats)
        return PostProcessResult(revision, report)
    }

    /** 逐条候选构建关系记录，返回构建成功的记录与未能构建的候选。 */
    private fun buildOccurrences(
        extractions: List<ChapterExtraction>,
        identities: AlignedIdentities,
        resolutions: Map<CandidateRef, com.zhiying.domain.relations.TypeResolution>,
        library: RelationTypeLibrary,
    ): Pair<List<RelationOccurrence>, List<BuildOutcome.Unbuilt>> {
        val builder = OccurrenceBuilder(library, identities.identityMap)
        val outcomes = extractions.flatMap { extraction ->
            extraction.candidates.map { candidate ->
                val ref = CandidateRef(extraction.chapterId, candidate.id)
                builder.build(extraction.chapterId, candidate, extraction.firstAssessmentOf(candidate.id), resolutions[ref])
            }
        }
        return outcomes.filterIsInstance<BuildOutcome.Built>().map { it.occurrence } to
            outcomes.filterIsInstance<BuildOutcome.Unbuilt>()
    }

    /** 把交流观察解析到书内人物；端点未绑定或合并后成同一人的观察不参与兜底。 */
    private fun resolveInteractions(
        extractions: List<ChapterExtraction>,
        identities: AlignedIdentities,
    ): List<ResolvedInteraction> = extractions.flatMap { it.interactions }.mapNotNull { observation ->
        val (a, b) = observation.participants.map { identities.identityMap.resolve(it) }
        if (a == null || b == null || a == b) null else ResolvedInteraction(PersonPair.of(a, b), observation)
    }
}
