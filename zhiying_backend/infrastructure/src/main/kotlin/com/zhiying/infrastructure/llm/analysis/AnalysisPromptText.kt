// 后处理提示词共用的文字渲染：人物、关系类型、硬度等在四个调用点里统一的呈现方式，以及 DTO 解析小工具。
package com.zhiying.infrastructure.llm.analysis

import com.zhiying.domain.identity.Gender
import com.zhiying.domain.identity.Person
import com.zhiying.domain.identity.PersonId
import com.zhiying.domain.relations.Direction
import com.zhiying.domain.relations.Hardness
import com.zhiying.domain.relations.RelationType
import com.zhiying.domain.relations.UndeterminedReason

/** 后处理四个调用点共用的渲染与解析函数。 */
internal object AnalysisPromptText {

    /** 硬度的中文称呼。 */
    fun hardness(h: Hardness): String = when (h) {
        Hardness.HARD -> "硬"
        Hardness.MEDIUM -> "中"
        Hardness.SOFT -> "软"
    }

    /** 方向的一句话描述；有向类型给出角色顺序。 */
    fun direction(d: Direction): String = when (d) {
        Direction.Undirected -> "无向（两端对等）"
        is Direction.Directed -> "有向：source=${d.sourceRole} -> target=${d.targetRole}"
    }

    /** 类型库中一个类型的一行描述：ID | 名称（同义名） | 硬度 | 方向 | 定义。 */
    fun typeLine(type: RelationType): String {
        val synonyms = type.synonyms.takeIf { it.isNotEmpty() }?.joinToString("、", "，同义：") ?: ""
        val reverse = type.reverseNames.takeIf { it.isNotEmpty() }?.joinToString("、", "，反向称呼：") ?: ""
        return "- ${type.id.value} | ${type.name}$synonyms$reverse | ${hardness(type.hardness)} | ${direction(type.direction)} | ${type.definition}"
    }

    /**
     * 人物的一行描述：引用、展示名、别名、性别、简介。
     * [ref] 默认是人物 ID；需要模型回传人物时传 [personRef] 短代号。
     */
    fun personLine(person: Person, ref: String = person.id.value): String {
        val aliases = person.aliases.joinToString("、").ifBlank { "无" }
        val gender = when (person.gender) {
            Gender.MALE -> "男"
            Gender.FEMALE -> "女"
            Gender.UNKNOWN -> "未知"
        }
        val profile = person.profile?.takeIf { it.isNotBlank() }?.let { "；简介：$it" }.orEmpty()
        return "$ref | ${person.displayName}（别名：$aliases；性别：$gender）$profile"
    }

    /** 提示里第 [index] 个人物的短代号（P1、P2……）：长 ID 容易被模型改写（如丢掉前缀），需要回传人物时一律用代号。 */
    fun personRef(index: Int): String = "P${index + 1}"

    /** 把模型回传的人物引用解析为人物 ID：认短代号（不分大小写），也认完整 ID；都不是返回 null。 */
    fun resolvePerson(raw: String, refs: Map<String, PersonId>): PersonId? {
        val key = raw.trim()
        return refs[key.uppercase()] ?: refs.values.firstOrNull { it.value == key }
    }

    /** 未决原因的中文说明。 */
    fun reason(reason: UndeterminedReason): String = when (reason) {
        UndeterminedReason.UNCLEAR_REFERENCE -> "指代或说话者不明"
        UndeterminedReason.AMBIGUOUS_TYPE_OR_DIRECTION -> "类型或方向含糊"
        UndeterminedReason.INSUFFICIENT_CONTEXT -> "当前片段不足"
        UndeterminedReason.FIGURATIVE_OR_HEARSAY -> "比喻、尊称或传闻，无法确定"
    }

    /** 解析模型给出的硬度词（hard/medium/soft，也接受中文），无法识别返回 null。 */
    fun parseHardness(raw: String?): Hardness? = when (raw?.trim()?.lowercase()) {
        "hard", "硬" -> Hardness.HARD
        "medium", "中" -> Hardness.MEDIUM
        "soft", "软" -> Hardness.SOFT
        else -> null
    }

    /** 解析模型给出的未决原因词（如 unclear_reference），无法识别返回 null。 */
    fun parseReason(raw: String?): UndeterminedReason? =
        raw?.trim()?.uppercase()?.replace('-', '_')?.let { key -> UndeterminedReason.entries.firstOrNull { it.name == key } }

    /** 取模型名配置：空串表示用默认模型。 */
    fun modelOf(configured: String): String? = configured.ifBlank { null }
}
