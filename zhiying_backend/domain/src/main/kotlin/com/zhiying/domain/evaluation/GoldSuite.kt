// 评测集的标准标注（DESIGN §7.1）：标准人物与别名、逐章的必有 / 可有 / 禁止关系，以及每条可接受的关系类型。
package com.zhiying.domain.evaluation

import com.zhiying.domain.relations.RelationType
import com.zhiying.domain.relations.TypeOrigin

/** 标准人物：正式名与别名，评分时按名字对齐结果人物。 */
data class GoldPerson(val name: String, val aliases: List<String> = emptyList()) {
    init {
        require(name.isNotBlank()) { "标准人物名不能为空" }
    }

    /** 全部可对齐的名字。 */
    val names: List<String> get() = listOf(name) + aliases
}

/**
 * 可接受的关系类型：内置类型 ID，或本书新类型名称里含有的关键词。
 *
 * 新类型 ID 由模型起名生成（`book:<名称>`），只能按关键词认；内置类型按 ID 精确匹配。
 */
data class TypeCriteria(val typeIds: Set<String>, val keywords: List<String> = emptyList()) {
    init {
        require(typeIds.isNotEmpty() || keywords.isNotEmpty()) { "至少要给出一个可接受的类型或关键词" }
    }

    /** 该类型是否可接受。 */
    fun accepts(type: RelationType): Boolean =
        type.id.value in typeIds || (type.origin == TypeOrigin.BOOK && keywords.any { kw -> type.allNames.any { kw in it } })
}

/**
 * 一条必有或可有的标准关系。
 *
 * 入参：[source] 有向时承担源角色的一端（必须是两端之一），无向为 null；[evidence] 标准引文，评分前自检能否在正文中找到；
 * [tier] 分档，null 时由可接受类型推断（见 [Tier]）。
 */
data class GoldRelation(
    val personA: String,
    val personB: String,
    val label: String,
    val criteria: TypeCriteria,
    val source: String? = null,
    val evidence: List<String> = emptyList(),
    val note: String? = null,
    val tier: Tier? = null,
) {
    init {
        require(personA != personB) { "标准关系两端不能是同一人：$personA" }
        require(source == null || source == personA || source == personB) { "源端必须是两端之一：$source" }
    }
}

/** 一条禁止项：同章出现已准入的这类关系即记一次违反，不区分方向。 */
data class GoldForbidden(
    val personA: String,
    val personB: String,
    val criteria: TypeCriteria,
    val reason: String,
    val evidence: List<String> = emptyList(),
)

/** 一章的标准。[number] 对应导入后第几个参与分析的章节（从 1 起）。 */
data class GoldChapter(
    val number: Int,
    val title: String,
    val required: List<GoldRelation>,
    val optional: List<GoldRelation>,
    val forbidden: List<GoldForbidden>,
) {
    init {
        require(number >= 1) { "标准章号从 1 开始" }
    }
}

/**
 * 一个评测集：一本书的标准人物与逐章标准。
 *
 * 入参：[name] 评测集名（即目录名）；[book] 书名，用来在书库里认书；[chapterCount] 正文章数。
 * 建立时校验章号连续且不超过正文章数，标准关系的两端都在标准人物里。
 */
data class GoldSuite(
    val name: String,
    val book: String,
    val chapterCount: Int,
    val cast: List<GoldPerson>,
    val chapters: List<GoldChapter>,
) {
    init {
        require(chapters.map { it.number } == (1..chapters.size).toList()) { "标准章号必须从 1 起连续" }
        require(chapters.size <= chapterCount) { "标准章数超过正文章数" }
        val known = cast.map { it.name }.toSet()
        val unknown = chapters.flatMap { ch ->
            (ch.required + ch.optional).flatMap { listOf(it.personA, it.personB) } + ch.forbidden.flatMap { listOf(it.personA, it.personB) }
        }.toSet() - known
        require(unknown.isEmpty()) { "标准关系引用了标准人物之外的名字：$unknown" }
    }
}
