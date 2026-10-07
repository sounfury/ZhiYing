// 出图的查询条件与展示分参数：都是调用方可调的输入，投影函数本身不读取任何配置。
package com.zhiying.domain.graph

import com.zhiying.domain.identity.PersonId
import com.zhiying.domain.relations.Hardness
import com.zhiying.domain.relations.RelationTypeId

/** 章节聚焦模式：只看第 N 章出场者，或累计前 N 章（PRD §5.7.1）。 */
enum class ChapterMode { SINGLE, UPTO }

/** 章节聚焦条件：[number] 为章节阅读序号（从 1 起，与响应里的章节编号同一口径），[mode] 为聚焦模式。 */
data class ChapterFocus(val number: Int, val mode: ChapterMode) {
    init {
        require(number >= 1) { "章节序号必须从 1 起" }
    }
}

/**
 * 出图查询条件。
 *
 * 入参：[minAppearance] 路人过滤阈值（最少出场章数，默认 2）；[focus] 聚焦人物（只保留其一度关系）；
 * [types] 只看这些关系类型（空表示不限）；[hardness] 只看这些硬度（空表示不限）；
 * [chapterFocus] 章节聚焦（空表示全书）。
 */
data class GraphQuery(
    val minAppearance: Int = DEFAULT_MIN_APPEARANCE,
    val focus: PersonId? = null,
    val types: Set<RelationTypeId> = emptySet(),
    val hardness: Set<Hardness> = emptySet(),
    val chapterFocus: ChapterFocus? = null,
) {
    init {
        require(minAppearance >= 0) { "最少出场章数不能为负" }
    }

    companion object {
        /** 路人过滤的默认阈值（PRD §5.7.7）。 */
        const val DEFAULT_MIN_APPEARANCE = 2
    }
}

/**
 * 展示分参数：展示分 = 类型基础分（硬 > 中 > 软）+ 出现章数 × [perChapter] + 带原文片段的证据加分。
 * 分数只用于排序与默认过滤，系数可调；任何系数组合都不能让一种关系吞并另一种。
 */
data class DisplayScoring(
    val hardBase: Double = 30.0,
    val mediumBase: Double = 20.0,
    val softBase: Double = 10.0,
    val perChapter: Double = 0.5,
    val quotedEvidenceBonus: Double = 1.0,
) {
    init {
        require(hardBase >= mediumBase && mediumBase >= softBase) { "基础分须满足 硬 >= 中 >= 软" }
        require(perChapter >= 0 && quotedEvidenceBonus >= 0) { "章数系数与证据加分不能为负" }
    }

    /** 某硬度的类型基础分。 */
    fun base(hardness: Hardness): Double = when (hardness) {
        Hardness.HARD -> hardBase
        Hardness.MEDIUM -> mediumBase
        Hardness.SOFT -> softBase
    }
}
