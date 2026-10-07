// 章阅读端口：把一章正文读成 ChapterExtraction；由基础设施用多轮工具循环实现，应用层只依赖这里的输入输出。
package com.zhiying.application.analyze.reading

import com.zhiying.application.diagnostics.ModelFailure
import com.zhiying.application.llm.ModelCallControl
import com.zhiying.application.llm.ModelCallStats
import com.zhiying.domain.extraction.ChapterExtraction
import com.zhiying.domain.extraction.ExtractionProvenance
import com.zhiying.domain.extraction.ReadingUnit
import com.zhiying.domain.identity.Person
import com.zhiying.domain.library.Chapter
import com.zhiying.domain.library.TextRevision
import com.zhiying.domain.relations.RelationTypeLibrary

/**
 * 章阅读的输入。
 *
 * 入参：[chapter] 待读章节；[unit] 本次只负责抽取的单元（长章的一段），null 表示整章；
 * 搜索、取证与引文校验始终覆盖整章 [chapter]；[roster] 当前人名册快照（只读，可为空）；[library] 可引用的关系类型库；
 * [priorSummary] 可选的前文摘要（长篇记忆，一期不注入）；[control] 任务级预算与取消信号。
 */
data class ChapterReadRequest(
    val chapter: Chapter,
    val unit: ReadingUnit? = null,
    val roster: List<Person> = emptyList(),
    val library: RelationTypeLibrary,
    val priorSummary: String? = null,
    val control: ModelCallControl = ModelCallControl(),
)

/** 章阅读的执行结果；无论成败都带本次用量。 */
sealed interface ChapterReadResult {
    /** 本次调用的请求数、token 与耗时。 */
    val stats: ModelCallStats

    /**
     * 读章完成。[warnings] 记录非致命问题，如正文未读完、未主动提交而由程序收尾；
     * 有警告的抽取仍可使用，是否重跑由调用方决定。
     */
    data class Completed(
        val extraction: ChapterExtraction,
        override val stats: ModelCallStats,
        val warnings: List<String> = emptyList(),
    ) : ChapterReadResult

    /** 执行失败（供应商错误、预算耗尽、取消、步数用尽且无可用结果）；不等于任何语义结论。 */
    data class Failed(
        val failure: ModelFailure,
        val message: String,
        override val stats: ModelCallStats,
    ) : ChapterReadResult
}

/** 章阅读端口：一章一次调用，失败用 [ChapterReadResult.Failed] 表达而不抛异常。 */
interface ChapterReader {
    /** 读取一章并产出抽取记录；会向模型服务发出真实请求。 */
    fun read(request: ChapterReadRequest): ChapterReadResult

    /** 当前读章所用的模型与提示词版本；已存抽取的溯源与它相等（正文修订也相同）时才可复用。 */
    fun provenanceFor(textRevision: TextRevision): ExtractionProvenance
}
