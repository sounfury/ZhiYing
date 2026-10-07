// 分析后处理工厂：把五个模型端口、补查上下文、类型缓存与批量上限装配成每个任务专属的 AnalysisPostProcessor。
package com.zhiying.application.analyze

import com.zhiying.application.analyze.identity.IdentityAlignmentStep
import com.zhiying.application.analyze.identity.IdentityDisambiguator
import com.zhiying.application.analyze.profile.ProfileLimits
import com.zhiying.application.analyze.profile.ProfileStep
import com.zhiying.application.analyze.profile.ProfileWriter
import com.zhiying.application.analyze.relations.RecheckBudget
import com.zhiying.application.analyze.relations.RecheckContextProvider
import com.zhiying.application.analyze.relations.RelationRecheckStep
import com.zhiying.application.analyze.relations.RelationRechecker
import com.zhiying.application.analyze.relations.RelationTypeResolver
import com.zhiying.application.analyze.relations.SoftFallbackFinder
import com.zhiying.application.analyze.relations.SoftFallbackStep
import com.zhiying.application.analyze.relations.TypeDecisionCache
import com.zhiying.application.analyze.relations.TypeNormalizationStep
import com.zhiying.application.llm.ModelCallControl
import com.zhiying.domain.identity.NameIndex
import org.springframework.stereotype.Service

/**
 * 后处理的批量与补查上限，由基础设施从 `zhiying.post-process.*` 构建；应用层不依赖配置类。
 *
 * 入参：[identity]、[typeResolution]、[fallback] 各步骤单次模型请求的条数与输入长度上限；
 * [recheck] 补查的单次请求上限与整个分析最多发出的补查请求数；
 * [coreMinAppearance] 区分重要人物与路人的出场章数阈值；
 * [profile] 全书简介的批量与材料上限；[appellationBridgeLimit] 稳定称呼参与身份候选桥接的共用人数上限。
 */
data class PostProcessLimits(
    val identity: BatchLimits,
    val typeResolution: BatchLimits,
    val recheck: RecheckBudget,
    val fallback: BatchLimits,
    val coreMinAppearance: Int = 2,
    val profile: ProfileLimits = ProfileLimits(),
    val appellationBridgeLimit: Int = NameIndex.DEFAULT_APPELLATION_BRIDGE_LIMIT,
)

/**
 * 后处理工厂。
 *
 * 端口实现与上限是进程级的，而取消信号与预算属于单次分析任务，所以每个任务调用 [create] 取一个新的处理器，
 * 各步骤共享同一份 [ModelCallControl]。
 */
@Service
class AnalysisPostProcessorFactory(
    private val disambiguator: IdentityDisambiguator,
    private val typeResolver: RelationTypeResolver,
    private val rechecker: RelationRechecker,
    private val fallbackFinder: SoftFallbackFinder,
    private val profileWriter: ProfileWriter,
    private val contexts: RecheckContextProvider,
    private val typeCache: TypeDecisionCache,
    private val limits: PostProcessLimits,
) {
    /**
     * 为一次分析任务创建后处理器。
     * 入参：[control] 该任务的预算与取消信号，传给所有模型调用。
     * 出参：可直接 [AnalysisPostProcessor.process] 的处理器；不跨任务复用。
     */
    fun create(control: ModelCallControl): AnalysisPostProcessor = AnalysisPostProcessor(
        identityStep = IdentityAlignmentStep(disambiguator, limits.identity, control, limits.appellationBridgeLimit),
        typeStep = TypeNormalizationStep(typeResolver, typeCache, limits.typeResolution, control),
        recheckStep = RelationRecheckStep(rechecker, contexts, limits.recheck, control),
        fallbackStep = SoftFallbackStep(
            fallbackFinder,
            RelationRecheckStep(rechecker, contexts, limits.recheck, control),
            limits.fallback,
            control,
            limits.coreMinAppearance,
        ),
        profileStep = ProfileStep(profileWriter, limits.profile, control, limits.coreMinAppearance),
    )
}
