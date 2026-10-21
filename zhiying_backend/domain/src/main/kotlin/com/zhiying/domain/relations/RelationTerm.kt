// 称谓与措辞：称谓是关系某一端的叫法（哥哥、妹妹），关系本身不分性别；
// 这里负责两件纯计算：称谓与人物性别是否矛盾（全书阶段剔除错读），以及一条关系在图上怎么说（「凯蒂 是 斯蒂芬 的 妹妹」）。
package com.zhiying.domain.relations

import com.zhiying.domain.identity.Gender
import com.zhiying.domain.identity.PersonId

/** 称谓在有向关系中的一端：源端承担 sourceRole，目标端承担 targetRole。无向关系的称谓都记作源端。 */
enum class Side { SOURCE, TARGET }

/** 一个内置称谓：[word] 属于关系 [type] 的 [side] 一端，本身指明性别 [gender]；[canonical] 是同组标准写法（爸爸 → 父亲）。 */
data class RelationTerm(val word: String, val type: RelationTypeId, val side: Side, val gender: Gender, val canonical: String)

/** 称谓所在的一端：属于正式名 / 同义名为源端，属于反向称呼为目标端，都不是为 null。 */
fun RelationType.sideOf(word: String): Side? = when (word) {
    in names -> Side.SOURCE
    in reverseNames -> Side.TARGET
    else -> null
}

/**
 * 原文称谓与所指人物的已知性别矛盾时返回说明（如男性被称作「母亲」），否则为 null。
 * 多半是读章时方向填反或指错了人，这条观察不能出图；只检查有向关系的内置称谓，性别未知时不判。
 */
fun RelationType.termGenderConflict(key: RelationKey, word: String?, genderOf: (PersonId) -> Gender): String? {
    if (direction !is Direction.Directed || word == null) return null
    val term = BuiltInRelationTypes.term(word)?.takeIf { it.type == id } ?: return null
    val person = if (term.side == Side.SOURCE) key.first else key.second
    val actual = genderOf(person)
    if (term.gender == Gender.UNKNOWN || actual == Gender.UNKNOWN || actual == term.gender) return null
    return "称谓「$word」与人物 ${person.value} 的性别矛盾"
}

/**
 * 一条关系事实的说法：读作「[from] 是 [to] 的 [label]」，[fromRole]、[toRole] 是两端各自的称谓。
 * 无向关系用关系名（夫妻、同学）；有向关系用称谓，箭头从称谓所指的人出发。
 */
data class Wording(val from: PersonId, val to: PersonId, val label: String, val fromRole: String, val toRole: String) {
    companion object {
        /**
         * 入参：[type] 关系类型；[key] 规范键；[terms] 各条观察的原文称谓（旧数据为 null）；[genderOf] 人物性别。
         * 每端取原文最常用的称谓（统一成标准写法），原文没有或称谓不带性别时按人物性别取（亲子 + 女 → 母亲），再不行用角色名。
         * 标签取原文说得更多的那一端，持平时取源端。
         */
        fun of(type: RelationType, key: RelationKey, terms: List<String?>, genderOf: (PersonId) -> Gender): Wording {
            val d = type.direction as? Direction.Directed ?: return Wording(key.first, key.second, type.name, type.name, type.name)
            val words = terms.filterNotNull()
            val sourceWords = words.filter { type.sideOf(it) == Side.SOURCE }
            val targetWords = words.filter { type.sideOf(it) == Side.TARGET }
            val source = roleWord(type, Side.SOURCE, sourceWords, genderOf(key.first)) ?: d.sourceRole
            val target = roleWord(type, Side.TARGET, targetWords, genderOf(key.second)) ?: d.targetRole
            return if (targetWords.size > sourceWords.size) {
                Wording(key.second, key.first, target, target, source)
            } else {
                Wording(key.first, key.second, source, source, target)
            }
        }

        /** 一端的称谓：原文最常用的标准写法；它不带性别而人物性别已知时，换成带性别的称谓。 */
        private fun roleWord(type: RelationType, side: Side, observed: List<String>, gender: Gender): String? {
            val best = observed.groupingBy { canonical(type, it) }.eachCount().maxByOrNull { it.value }?.key
            val genderless = best == null || (BuiltInRelationTypes.term(best)?.gender ?: Gender.UNKNOWN) == Gender.UNKNOWN
            return if (genderless) BuiltInRelationTypes.wordFor(type.id, side, gender) ?: best else best
        }

        /** 称谓的标准写法；本书新类型的名称原样返回。 */
        private fun canonical(type: RelationType, word: String): String =
            BuiltInRelationTypes.term(word)?.takeIf { it.type == type.id }?.canonical ?: word
    }
}
