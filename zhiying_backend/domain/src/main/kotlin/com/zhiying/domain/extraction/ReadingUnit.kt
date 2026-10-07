// 阅读单元：整书分析调度的最小读取粒度（一章，或超长章的一段），以及同章各段抽取的前缀隔离与合并。纯计算，不依赖框架。
package com.zhiying.domain.extraction

import com.zhiying.domain.identity.LocalPersonRef
import com.zhiying.domain.identity.MentionId
import com.zhiying.domain.identity.PersonMention
import com.zhiying.domain.library.ChapterId
import com.zhiying.domain.library.EvidenceId
import com.zhiying.domain.library.EvidenceRef
import com.zhiying.domain.relations.CandidateId
import com.zhiying.domain.relations.InteractionId

/**
 * 一个阅读单元：章内的半开区间 [start, end)，坐标为 UTF-16 代码单元。
 *
 * 入参：[index] 单元在本章内的序号（从 1 起）；[count] 本章共切成几个单元，1 表示整章一个单元。
 */
data class ReadingUnit(val chapterId: ChapterId, val index: Int, val count: Int, val start: Int, val end: Int) {
    init {
        require(count >= 1 && index in 1..count) { "单元序号 $index 不在 1..$count 内" }
        require(start in 0 until end) { "单元区间不合法: [$start, $end)" }
    }

    /** 是否整章一个单元（此时不加任何前缀）。 */
    val whole: Boolean get() = count == 1

    /** 单元长度。 */
    val length: Int get() = end - start

    /** 本单元内的局部编号、提及与候选等 ID 使用的前缀；整章单元为空串。 */
    val prefix: String get() = if (whole) "" else "s$index-"
}

/** 阅读单元的切分规则与同章多段抽取的合并规则。 */
object ReadingUnits {

    /**
     * 把一章切成阅读单元。
     *
     * 入参：[text] 章正文；[maxChars] 单元字数上限（> 0）。
     * 规则：不超过上限整章一个单元；否则先定段数 n = ⌈字数 / 上限⌉ 再均分，
     * 每个切点在目标位置附近（±均分长度的 1/4）按「场景分隔行 → 段落边界 → 句末标点 → 硬切」依次退让，
     * 同一优先级取离目标最近者。不做语义切片；无标点的意识流章走硬切，不做特殊处理。
     */
    fun plan(chapterId: ChapterId, text: String, maxChars: Int): List<ReadingUnit> {
        require(maxChars > 0) { "切段上限必须为正" }
        if (text.isEmpty()) return emptyList()
        val count = (text.length + maxChars - 1) / maxChars
        if (count == 1) return listOf(ReadingUnit(chapterId, 1, 1, 0, text.length))
        val radius = text.length / count / 4
        val cuts = mutableListOf(0)
        for (i in 1 until count) {
            val target = text.length * i / count
            cuts += cutNear(text, target, maxOf(cuts.last() + 1, target - radius), minOf(text.length - 1, target + radius))
        }
        cuts += text.length
        return (0 until count).map { ReadingUnit(chapterId, it + 1, count, cuts[it], cuts[it + 1]) }
    }

    /** 在 [low, high] 内按优先级选切点；都没有就在目标处硬切（不切开代理对）。 */
    private fun cutNear(text: String, target: Int, low: Int, high: Int): Int {
        val range = low..high
        val picked = listOf<(Int) -> Boolean>(
            { isSceneBreak(text, it) },
            { isParagraphBreak(text, it) },
            { isSentenceEnd(text, it) },
        ).firstNotNullOfOrNull { rule -> range.filter(rule).minWithOrNull(compareBy({ kotlin.math.abs(it - target) }, { it })) }
        if (picked != null) return picked
        val hard = target.coerceIn(low.coerceAtLeast(1), text.length - 1)
        return if (!text[hard].isLowSurrogate()) hard else if (hard - 1 >= low) hard - 1 else hard + 1
    }

    /** 位置 p 前一行是空行或纯符号行（＊＊＊、※、——等）：在其后切。 */
    private fun isSceneBreak(text: String, p: Int): Boolean {
        if (!isParagraphBreak(text, p)) return false
        val lineStart = text.lastIndexOf('\n', p - 2) + 1
        val line = text.substring(lineStart, p - 1)
        return line.isBlank() || line.all { it.isWhitespace() || it in SCENE_SYMBOLS }
    }

    /** 位置 p 恰是一行的开头（前一个字符是换行）。 */
    private fun isParagraphBreak(text: String, p: Int): Boolean = p in 1 until text.length && text[p - 1] == '\n'

    /** 位置 p 紧接句末标点（及其后的引号、括号收尾）。 */
    private fun isSentenceEnd(text: String, p: Int): Boolean {
        if (p !in 1 until text.length || text[p] in CLOSERS) return false
        val last = text[p - 1]
        return last in SENTENCE_ENDS || (last in CLOSERS && p >= 2 && text[p - 2] in SENTENCE_ENDS)
    }

    /**
     * 给单元内抽取的局部人物编号、提及、候选、交流、依据加上单元前缀，避免同章各段 ID 冲突。
     * 整章单元原样返回。滚动人名册对齐也使用加过前缀的抽取，保证新人物 ID（p:章:局部编号）互不冲突。
     */
    fun scope(extraction: ChapterExtraction, unit: ReadingUnit): ChapterExtraction {
        if (unit.whole) return extraction
        val p = unit.prefix
        fun ref(r: LocalPersonRef) = LocalPersonRef(r.chapterId, p + r.key)
        fun evidence(e: EvidenceRef) = e.copy(id = EvidenceId(p + e.id.value))
        return ChapterExtraction(
            id = extraction.id,
            chapterId = extraction.chapterId,
            provenance = extraction.provenance,
            mentions = extraction.mentions.map { it.copy(id = MentionId(p + it.id.value), person = ref(it.person)) },
            claims = extraction.claims.map { it.copy(person = ref(it.person)) },
            candidates = extraction.candidates.map {
                it.copy(id = CandidateId(p + it.id.value), source = ref(it.source), target = ref(it.target), evidence = it.evidence.map(::evidence))
            },
            firstAssessments = extraction.firstAssessments.map { it.copy(candidate = CandidateId(p + it.candidate.value)) },
            interactions = extraction.interactions.map {
                it.copy(id = InteractionId(p + it.id.value), participants = it.participants.mapTo(linkedSetOf(), ::ref), evidence = evidence(it.evidence))
            },
            summary = extraction.summary,
        )
    }

    /**
     * 把同一章各单元（已 [scope]）的抽取合并成一份章抽取：各类记录按单元顺序拼接，摘要依次拼接。
     * 入参：[parts] 按单元顺序排列、非空，且属于同一章；[id] 合并后的抽取 ID；溯源取第一段（各段同模型同提示）。
     */
    fun merge(id: ExtractionId, parts: List<ChapterExtraction>): ChapterExtraction {
        require(parts.isNotEmpty()) { "没有可合并的抽取" }
        val chapterId = parts.first().chapterId
        require(parts.all { it.chapterId == chapterId }) { "只能合并同一章的抽取" }
        return ChapterExtraction(
            id = id,
            chapterId = chapterId,
            provenance = parts.first().provenance,
            mentions = parts.flatMap { it.mentions },
            claims = parts.flatMap { it.claims },
            candidates = parts.flatMap { it.candidates },
            firstAssessments = parts.flatMap { it.firstAssessments },
            interactions = parts.flatMap { it.interactions },
            summary = ChapterSummary(parts.joinToString("\n") { it.summary.text }),
        )
    }

    private val SCENE_SYMBOLS = "*＊※◇◆○●■□—-－_＿=~～·•.#＃".toSet()
    private val SENTENCE_ENDS = "。！？!?…；;".toSet()
    private val CLOSERS = "」』”’）)】》\"'".toSet()
}
