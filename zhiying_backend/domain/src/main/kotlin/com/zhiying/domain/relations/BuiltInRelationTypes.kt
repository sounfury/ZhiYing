// 内置关系类型库：46 个高频关系，以及每种关系两端可用的称谓（带性别），是半开放类型库的起点（罕见关系由各书登记为新类型）。
package com.zhiying.domain.relations

import com.zhiying.domain.identity.Gender

/**
 * 内置类型数据（domain 不读文件，直接用 Kotlin 定义）。
 *
 * 关系与称谓分开：
 * - 关系不分性别，同一对人一种关系只存一条，如「手足（长幼）」= 年长一方 → 年幼一方；
 * - 称谓是关系某一端的叫法，带性别，如哥哥（源端，男）、妹妹（目标端，女）。读章时模型按原文写「A 是 B 的妹妹」，
 *   程序据称谓所在的一端换成规范方向；出图时再按原文称谓或人物性别取回「哥哥」「妹妹」。
 *
 * 分档：硬关系 18 个（精确亲属 / 婚恋 / 师承 14 个，宽泛亲属 4 个）；中关系 23 个；软关系 5 个，只作兜底。
 * 宽泛亲属（兄弟姐妹、祖孙、叔侄、堂表亲）只在原文信息不足时使用；同一对人已有对应的精确关系时，出图并入精确关系（见 [broaderOf]）。
 */
object BuiltInRelationTypes {

    /** 全部内置类型。 */
    val all: List<RelationType> get() = defs.map { it.type }

    /** 仅含内置类型的类型库；各书在此基础上登记新类型。 */
    fun library(): RelationTypeLibrary = RelationTypeLibrary.of(all)

    /** 按词查内置称谓；不是内置称谓（含本书新类型的名称）时为 null。 */
    fun term(word: String): RelationTerm? = terms[word.trim()]

    /** 内置关系 [type] 在 [side] 一端、性别为 [gender] 的标准称谓，如（亲子，源端，女）→ 母亲；性别未知或没有对应称谓时为 null。 */
    fun wordFor(type: RelationTypeId, side: Side, gender: Gender): String? =
        if (gender == Gender.UNKNOWN) null else terms.values.firstOrNull { it.type == type && it.side == side && it.gender == gender }?.canonical

    /** 宽泛关系 → 精确关系：返回 [type] 所归属的宽泛关系（如 手足（长幼）→ 兄弟姐妹），没有时为 null。 */
    fun broaderOf(type: RelationTypeId): RelationTypeId? = broader[type]

    /** 一组同义称谓：首个词是标准写法，[gender] 是称谓本身指明的性别。 */
    private class Words(val gender: Gender, val words: List<String>)

    private fun m(vararg w: String) = Words(Gender.MALE, w.toList())
    private fun f(vararg w: String) = Words(Gender.FEMALE, w.toList())
    private fun n(vararg w: String) = Words(Gender.UNKNOWN, w.toList())

    /** 一个内置类型及其两端称谓；无向类型的称谓都记在源端。 */
    private class Def(val type: RelationType, val source: List<Words>, val target: List<Words>, val broader: String?)

    private fun def(
        id: String,
        name: String,
        hardness: Hardness,
        direction: Direction,
        definition: String,
        source: List<Words> = emptyList(),
        target: List<Words> = emptyList(),
        broader: String? = null,
    ): Def {
        val synonyms = source.flatMap { it.words }.toSet() - name
        val reverse = target.flatMap { it.words }.toSet()
        return Def(RelationType(RelationTypeId(id), name, definition, hardness, direction, synonyms, TypeOrigin.BUILT_IN, reverse), source, target, broader)
    }

    private fun dir(source: String, target: String) = Direction.Directed(source, target)
    private val undirected = Direction.Undirected
    private val hard = Hardness.HARD
    private val medium = Hardness.MEDIUM
    private val soft = Hardness.SOFT

    private val defs: List<Def> = listOf(
        // ── 硬：精确亲属、婚恋、师承 ──
        def("spouse_of", "夫妻", hard, undirected, "双方已结婚；恋爱、订婚不算",
            listOf(n("夫妻", "配偶"), m("丈夫", "老公", "夫君"), f("妻子", "老婆", "太太"))),
        def("parent_of", "亲子", hard, dir("父母", "子女"), "甲是乙的生父或生母；收养、养育关系另见养亲",
            listOf(m("父亲", "爸爸", "爹", "生父"), f("母亲", "妈妈", "娘", "生母"), n("父母", "双亲")),
            listOf(m("儿子"), f("女儿"), n("子女", "孩子"))),
        def("adoptive_parent_of", "养亲", hard, dir("养父母", "养子女"), "甲是乙的养父或养母；收养或养育关系，不是生父母",
            listOf(m("养父"), f("养母"), n("养父母")), listOf(m("养子"), f("养女"), n("养子女"))),
        def("step_parent_of", "继亲", hard, dir("继父母", "继子女"), "甲因与乙的生父或生母再婚而成为乙的继父或继母",
            listOf(m("继父"), f("继母"), n("继父母")), listOf(m("继子"), f("继女"), n("继子女"))),
        def("elder_sibling_of", "手足（长幼）", hard, dir("哥哥/姐姐", "弟弟/妹妹"), "甲是乙年长的兄弟姐妹，乙年幼",
            listOf(m("哥哥", "兄长", "大哥"), f("姐姐", "大姐")), listOf(m("弟弟"), f("妹妹")), broader = "sibling_of"),
        def("paternal_grandparent_of", "祖孙（父系）", hard, dir("祖父/祖母", "孙子/孙女"), "甲是乙父亲的父亲或母亲",
            listOf(m("祖父", "爷爷"), f("祖母", "奶奶")), listOf(m("孙子"), f("孙女")), broader = "grandparent_of"),
        def("maternal_grandparent_of", "祖孙（母系）", hard, dir("外祖父/外祖母", "外孙/外孙女"), "甲是乙母亲的父亲或母亲",
            listOf(m("外祖父", "外公", "姥爷"), f("外祖母", "外婆", "姥姥")), listOf(m("外孙"), f("外孙女")), broader = "grandparent_of"),
        def("paternal_uncle_aunt_of", "叔侄（父系）", hard, dir("叔伯/姑姑", "侄子/侄女"), "甲是乙父亲的兄弟姐妹（伯父、叔父、姑姑）",
            listOf(m("叔伯"), m("伯父", "大伯", "伯伯"), m("叔父", "叔叔"), f("姑姑", "姑妈", "姑母")),
            listOf(m("侄子", "侄儿"), f("侄女")), broader = "uncle_aunt_of"),
        def("maternal_uncle_aunt_of", "舅甥（母系）", hard, dir("舅舅/姨妈", "外甥/外甥女"), "甲是乙母亲的兄弟姐妹（舅舅、姨妈）",
            listOf(m("舅舅", "舅父"), f("姨妈", "姨母")), listOf(m("外甥"), f("外甥女")), broader = "uncle_aunt_of"),
        def("elder_paternal_cousin_of", "堂亲（长幼）", hard, dir("堂兄/堂姐", "堂弟/堂妹"), "甲是乙年长的堂亲（父亲兄弟的子女），乙年幼",
            listOf(m("堂兄", "堂哥"), f("堂姐")), listOf(m("堂弟"), f("堂妹")), broader = "cousin_of"),
        def("elder_cousin_of", "表亲（长幼）", hard, dir("表兄/表姐", "表弟/表妹"), "甲是乙年长的表亲（姑姑、舅舅、姨妈的子女），乙年幼",
            listOf(m("表兄", "表哥"), f("表姐")), listOf(m("表弟"), f("表妹")), broader = "cousin_of"),
        def("lover_of", "恋人", hard, undirected, "双方明确是恋爱或情侣关系；单方面爱慕不算",
            listOf(n("恋人", "情侣", "恋爱"), m("男友", "男朋友"), f("女友", "女朋友"))),
        def("engaged_to", "婚约", hard, undirected, "双方订有婚约，尚未成婚",
            listOf(n("婚约", "订婚", "未婚夫妻"), m("未婚夫"), f("未婚妻"))),
        def("mentor_of", "师徒", hard, dir("师父", "徒弟"), "甲与乙有明确师承；拒绝拜师或偶尔请教不成立",
            listOf(n("师父", "师傅", "师尊")), listOf(n("徒弟", "弟子", "徒儿", "门徒"))),

        // ── 硬：宽泛亲属，原文信息不足以细分时才用 ──
        def("sibling_of", "兄弟姐妹", hard, undirected, "双方是兄弟姐妹，但无法确定长幼",
            listOf(n("兄弟姐妹", "手足", "兄妹", "姐弟"), m("兄弟"), f("姐妹"))),
        def("grandparent_of", "祖孙", hard, dir("祖辈", "孙辈"), "祖孙关系，但父系 / 母系不明确",
            listOf(n("祖辈", "祖父母")), listOf(n("孙辈", "孙儿"))),
        def("uncle_aunt_of", "叔侄", hard, dir("长辈", "晚辈"), "隔一代的旁系近亲（叔伯、姑姑、舅舅、姨妈与侄甥），父系 / 母系不明确"),
        def("cousin_of", "堂表亲", hard, undirected, "同辈堂亲或表亲，无法判断长幼；不含叔侄、舅甥",
            listOf(n("堂表亲", "表亲", "堂亲", "堂兄弟", "表兄弟", "堂姐妹", "表姐妹"))),

        // ── 中：有稳定剧情意义 ──
        def("romantic_interest_in", "单恋", medium, dir("倾慕者", "被倾慕者"), "甲单方面爱慕乙；不等于恋人",
            listOf(n("倾慕者", "暗恋者", "暗恋", "倾慕")), listOf(n("被倾慕者", "暗恋对象"))),
        def("master_of", "主仆", medium, dir("主人", "仆从"), "甲是乙的主人，乙是其仆从",
            listOf(n("主人")), listOf(n("仆从", "仆人", "奴仆"))),
        def("superior_of", "上下级", medium, dir("上级", "下级"), "甲在组织中是乙的上级",
            listOf(n("上级", "上司")), listOf(n("下级", "下属"))),
        def("employer_of", "雇佣", medium, dir("雇主", "雇员"), "甲雇佣乙，双方为雇主与雇员",
            listOf(n("雇主", "东家")), listOf(n("雇员", "伙计"))),
        def("sovereign_subject_of", "君臣", medium, dir("君主", "臣子"), "甲是乙的君主，乙是其臣子",
            listOf(n("君主")), listOf(n("臣子", "臣下"))),
        def("teacher_student_of", "师生", medium, dir("老师", "学生"), "甲是乙的老师（教学关系，非正式师承）",
            listOf(n("老师")), listOf(n("学生"))),
        def("colleague_of", "同事", medium, undirected, "双方稳定共事"),
        def("business_partner_of", "商业伙伴", medium, undirected, "双方有商业合作关系", listOf(n("合伙人", "生意伙伴"))),
        def("classmate_of", "同学", medium, undirected, "双方有共同就学的同学身份"),
        def("fellow_disciple_of", "同门", medium, undirected, "双方出自同一师承或门派",
            listOf(n("师兄弟", "师姐妹", "师兄", "师姐", "师弟", "师妹"))),
        def("ally_of", "结盟", medium, undirected, "双方已建立联盟", listOf(n("盟友"))),
        def("enemy_of", "敌对", medium, undirected, "双方明确互为敌对对象", listOf(n("敌人", "仇敌"))),
        def("rival_of", "对手", medium, undirected, "双方互相竞争，不必达到敌对", listOf(n("竞争对手"))),
        def("protector_of", "保护", medium, dir("保护者", "被保护者"), "甲对乙有稳定的保护职责或行为",
            listOf(n("保护者")), listOf(n("被保护者"))),
        def("benefactor_of", "恩人", medium, dir("恩人", "受恩者"), "甲对乙有重大帮助或恩惠",
            listOf(n("恩人", "救命恩人")), listOf(n("受恩者"))),
        def("guardian_of", "监护", medium, dir("监护人", "被监护人"), "甲是乙的监护人（非生父母或养父母）",
            listOf(n("监护人")), listOf(n("被监护人"))),
        def("companion_of", "同行", medium, undirected, "双方稳定同行或搭档", listOf(n("搭档", "同伴", "旅伴"))),
        def("comrade_of", "战友", medium, undirected, "双方并肩作战或同属一个战斗集体"),
        def("in_law_of", "姻亲", medium, undirected, "因婚姻形成的亲属（岳父母、公婆、女婿、儿媳、姐夫等），方向不加区分",
            listOf(n("岳父", "岳母", "公婆", "女婿", "儿媳", "亲家", "妯娌", "连襟"))),
        def("ex_spouse_of", "前任", medium, undirected, "双方曾是夫妻，现已离异或婚姻已终止",
            listOf(n("离异"), m("前夫"), f("前妻"))),
        def("sworn_sibling_of", "结拜", medium, undirected, "双方结拜为兄弟姐妹，非血缘手足",
            listOf(n("义兄弟", "结拜兄弟", "义结金兰"))),
        def("close_friend_of", "挚友", medium, undirected, "文本明确表现双方长期、深厚、彼此知心的友谊；只是相处融洽、一次相助或短期交好不算",
            listOf(n("知己", "至交", "密友", "莫逆之交"))),
        def("sworn_kin_of", "义亲", medium, dir("义父母", "义子女"), "双方通过认干亲、拜义父义母等方式结成亲属般的关系，非血缘、非收养；结拜兄弟姐妹另见「结拜」",
            listOf(m("义父", "干爹"), f("义母", "干妈", "干娘"), n("义父母", "干亲")),
            listOf(m("义子", "干儿子"), f("义女", "干女儿"), n("义子女"))),

        // ── 软：粗粒度兜底，具体标签不得超出依据 ──
        def("friend_of", "朋友", soft, undirected, "双方有明确的友谊", listOf(n("友人", "好友"))),
        def("acquaintance_of", "相识", soft, undirected, "双方相互认识，但没有足够依据证明更具体的关系", listOf(n("认识"))),
        def("neighbor_of", "邻居", soft, undirected, "双方是邻居"),
        def("fellow_townsman_of", "同乡", soft, undirected, "双方来自同一地方"),
        def("interacts_with", "互动", soft, undirected, "双方在正文中确有实际交流，不能只凭同框推断", listOf(n("同场互动"))),
    )

    private val terms: Map<String, RelationTerm> = defs.flatMap { d ->
        fun side(groups: List<Words>, side: Side) = groups.flatMap { g -> g.words.map { RelationTerm(it, d.type.id, side, g.gender, g.words.first()) } }
        side(d.source, Side.SOURCE) + side(d.target, Side.TARGET)
    }.associateBy { it.word }

    private val broader: Map<RelationTypeId, RelationTypeId> =
        defs.mapNotNull { d -> d.broader?.let { d.type.id to RelationTypeId(it) } }.toMap()
}
