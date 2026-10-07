// 章节是否参与分析的可检查结论：参与，或带明确原因地不参与；由标题、正文特征与字数规则判定，纯计算。
package com.zhiying.domain.library

/** 章节不参与分析的原因；[label] 供界面与日志直接展示。 */
enum class ExclusionReason(val label: String) {
    /** 正文字数低于阈值（扉页、空白页、分隔页等）。 */
    TOO_SHORT("过短"),

    /** 目录页。 */
    TABLE_OF_CONTENTS("目录页"),

    /** 版权页、出版说明、致谢。 */
    COPYRIGHT("版权页"),

    /** 导读、序言、前言、译序等前置说明。 */
    FRONT_MATTER("前置说明"),

    /** 年表、附录、注释、参考文献等资料。 */
    APPENDIX("附录资料"),

    /** 后记、跋、作者简介等后置说明。 */
    BACK_MATTER("后置说明"),
}

/** 章节是否参与分析：[Included] 或 [Excluded]（带原因）。 */
sealed interface ChapterInclusion {
    /** 是否参与分析。 */
    val included: Boolean get() = this is Included

    /** 参与分析。 */
    data object Included : ChapterInclusion

    /** 不参与分析，附原因。 */
    data class Excluded(val reason: ExclusionReason) : ChapterInclusion

    companion object {
        /** 正文分节强信号：命中即视为正文，不再看非正文关键字。 */
        private val BODY_TITLE = Regex(
            "第[\\d一二三四五六七八九十百千]+[章回节部卷集]|Chapter\\s+\\d+|Part\\s+\\d+",
            RegexOption.IGNORE_CASE,
        )

        /** 非正文标题关键字，按顺序匹配，先命中者决定原因。吃不准时默认参与分析（宁可多分析，不漏正文）。 */
        private val NON_BODY_TITLES: List<Pair<Regex, ExclusionReason>> = listOf(
            Regex("目录|contents", RegexOption.IGNORE_CASE) to ExclusionReason.TABLE_OF_CONTENTS,
            Regex("版权|出版说明|copyright|acknowledg", RegexOption.IGNORE_CASE) to ExclusionReason.COPYRIGHT,
            Regex("导读|序言|前言|译序|再版序|preface|foreword|translator'?s\\s+note", RegexOption.IGNORE_CASE)
                to ExclusionReason.FRONT_MATTER,
            Regex("年表|大事记|附录|注释|参考文献|chronology|appendix", RegexOption.IGNORE_CASE)
                to ExclusionReason.APPENDIX,
            Regex("译后记|后记|^跋$|跋言|作者简介") to ExclusionReason.BACK_MATTER,
        )

        /** 转换工具给无标题片段填的占位名（如 Calibre 的「未知」），视同无标题。 */
        private val PLACEHOLDER_TITLES = setOf("未知", "unknown", "untitled", "无标题")

        /** 版权页正文特征：CIP 数据、ISBN、版权声明、版本记录，命中两类即视为版权页。 */
        private val COPYRIGHT_MARKERS = listOf(
            Regex("图书在版编目|CIP\\s*数据|CIP\\s*核字", RegexOption.IGNORE_CASE),
            Regex("ISBN", RegexOption.IGNORE_CASE),
            Regex("版权所有|侵权必究|All rights reserved", RegexOption.IGNORE_CASE),
            Regex("责任编辑|出版发行|印\\s*刷|开\\s*本|印\\s*张|定\\s*价"),
        )

        /** 按正文判定版权页时的最大字数：正文章节偶尔提到 ISBN 不应被误排除。 */
        private const val COPYRIGHT_MAX_WORDS = 1_500

        /**
         * 判定一章是否参与分析。
         *
         * 流程：字数不足 → 过短；标题命中正文分节 → 参与；短章正文像版权页 → 版权页；
         * 无标题（含占位名）→ 参与；标题命中非正文关键字 → 对应原因；否则参与。
         * 入参：[title] 章节标题；[text] 正文；[wordCount] 字数；[minWords] 参与分析的最低字数。出参：判定结论。
         */
        fun judge(title: String, text: String, wordCount: Int, minWords: Int): ChapterInclusion {
            val t = title.trim().takeUnless { it.lowercase() in PLACEHOLDER_TITLES }.orEmpty()
            return when {
                wordCount < minWords -> Excluded(ExclusionReason.TOO_SHORT)
                BODY_TITLE.containsMatchIn(t) -> Included
                wordCount <= COPYRIGHT_MAX_WORDS && COPYRIGHT_MARKERS.count { it.containsMatchIn(text) } >= 2 ->
                    Excluded(ExclusionReason.COPYRIGHT)
                t.isEmpty() -> Included
                else -> NON_BODY_TITLES.firstOrNull { it.first.containsMatchIn(t) }
                    ?.let { Excluded(it.second) } ?: Included
            }
        }
    }
}
