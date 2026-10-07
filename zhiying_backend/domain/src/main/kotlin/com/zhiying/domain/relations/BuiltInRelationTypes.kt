// 内置关系类型库：59 个高频类型，是半开放类型库的起点（罕见关系由各书登记为新类型）。
// 来源：旧 relation_seeds.json 的 13 类 + 旧重构方案 §7 的亲属精确类型、宽泛兜底类型与硬中软分档。
package com.zhiying.domain.relations

/**
 * 内置类型数据（domain 不读文件，直接用 Kotlin 定义）。
 *
 * 分档：
 * - 硬关系 31 个：精确亲属 / 婚恋 / 师承 24 个，宽泛亲属兜底 7 个（亲子、夫妻、养亲、兄弟姐妹、祖孙、叔侄、堂表亲）；
 * - 中关系 23 个：从属、组织、同门、结盟、敌对等有稳定剧情意义的关系；
 * - 软关系 5 个：朋友、相识、邻居、同乡、互动，只作兜底，且都很粗。
 *
 * 方向约定：有向类型按"源端承担 sourceRole"存储，同一事实只有一个规范方向。
 * 因此只收录"年长 / 长辈 / 上位"一端的称谓（哥哥、姐姐、堂兄、伯父等）；"弟弟 / 妹妹 / 侄子"之类
 * 是同一事实从另一端的叫法，只作反向称呼或写入目标端角色，不单独成类型，避免同一事实存成两条记录。
 * 无法由名称唯一确定方向的称呼（如"弟弟"可能对应哥哥或姐姐）交给类型归一的模型判断。
 */
object BuiltInRelationTypes {

    /** 全部内置类型。 */
    val all: List<RelationType> = kinship() + fallbackKinship() + strongSocial() + softSocial()

    /** 仅含内置类型的类型库；各书在此基础上登记新类型。 */
    fun library(): RelationTypeLibrary = RelationTypeLibrary.of(all)

    /** 构造一个内置类型。 */
    private fun type(
        id: String,
        name: String,
        hardness: Hardness,
        direction: Direction,
        definition: String,
        synonyms: Set<String> = emptySet(),
        reverse: Set<String> = emptySet(),
    ) = RelationType(RelationTypeId(id), name, definition, hardness, direction, synonyms, TypeOrigin.BUILT_IN, reverse)

    private fun hard(id: String, name: String, direction: Direction, definition: String, syn: Set<String> = emptySet(), rev: Set<String> = emptySet()) =
        type(id, name, Hardness.HARD, direction, definition, syn, rev)

    private fun medium(id: String, name: String, direction: Direction, definition: String, syn: Set<String> = emptySet(), rev: Set<String> = emptySet()) =
        type(id, name, Hardness.MEDIUM, direction, definition, syn, rev)

    private fun soft(id: String, name: String, definition: String, syn: Set<String> = emptySet()) =
        type(id, name, Hardness.SOFT, Direction.Undirected, definition, syn)

    private fun dir(source: String, target: String) = Direction.Directed(source, target)

    /** 精确亲属、婚恋与师承（硬）：原文有明确称谓时优先使用。 */
    private fun kinship(): List<RelationType> = listOf(
        hard("husband_of", "丈夫", dir("丈夫", "妻子"), "甲是乙的丈夫（即乙是甲的妻子）；已婚，恋爱不算", setOf("老公", "夫君"), setOf("妻子", "老婆", "太太")),
        hard("father_of", "父亲", dir("父亲", "子女"), "甲是乙的生父", setOf("爸爸", "爹", "生父")),
        hard("mother_of", "母亲", dir("母亲", "子女"), "甲是乙的生母", setOf("妈妈", "娘", "生母")),
        hard("adoptive_father_of", "养父", dir("养父", "养子女"), "甲是乙的养父；养育或收养关系，不是生父"),
        hard("adoptive_mother_of", "养母", dir("养母", "养子女"), "甲是乙的养母；养育或收养关系，不是生母"),
        hard("step_parent_of", "继父母", dir("继父母", "继子女"), "甲因与乙的生父或生母再婚而成为乙的继父或继母", setOf("继父", "继母"), setOf("继子", "继女", "继子女")),
        hard("older_brother_of", "哥哥", dir("哥哥", "弟弟/妹妹"), "甲是乙的哥哥（年长的男性手足，乙为弟或妹）", setOf("兄长", "大哥")),
        hard("older_sister_of", "姐姐", dir("姐姐", "弟弟/妹妹"), "甲是乙的姐姐（年长的女性手足，乙为弟或妹）", setOf("姐", "大姐")),
        hard("paternal_grandfather_of", "祖父", dir("祖父", "孙辈"), "甲是乙的父系祖父", setOf("爷爷")),
        hard("paternal_grandmother_of", "祖母", dir("祖母", "孙辈"), "甲是乙的父系祖母", setOf("奶奶")),
        hard("maternal_grandfather_of", "外祖父", dir("外祖父", "外孙辈"), "甲是乙的母系祖父", setOf("外公", "姥爷")),
        hard("maternal_grandmother_of", "外祖母", dir("外祖母", "外孙辈"), "甲是乙的母系祖母", setOf("外婆", "姥姥")),
        hard("elder_paternal_uncle_of", "伯父", dir("伯父", "侄子女"), "甲是乙父亲的哥哥", setOf("大伯", "伯伯")),
        hard("younger_paternal_uncle_of", "叔父", dir("叔父", "侄子女"), "甲是乙父亲的弟弟", setOf("叔叔")),
        hard("paternal_aunt_of", "姑姑", dir("姑姑", "侄子女"), "甲是乙父亲的姐妹", setOf("姑妈", "姑母")),
        hard("maternal_uncle_of", "舅舅", dir("舅舅", "外甥"), "甲是乙母亲的兄弟", setOf("舅父")),
        hard("maternal_aunt_of", "姨妈", dir("姨妈", "外甥"), "甲是乙母亲的姐妹", setOf("姨母")),
        hard("paternal_older_male_cousin_of", "堂兄", dir("堂兄", "堂弟/堂妹"), "甲是乙年长的男性堂亲（父系同辈）", setOf("堂哥")),
        hard("paternal_older_female_cousin_of", "堂姐", dir("堂姐", "堂弟/堂妹"), "甲是乙年长的女性堂亲（父系同辈）", setOf("堂姊")),
        hard("older_male_cousin_of", "表兄", dir("表兄", "表弟/表妹"), "甲是乙年长的男性表亲（母系或姑舅姨同辈）", setOf("表哥")),
        hard("older_female_cousin_of", "表姐", dir("表姐", "表弟/表妹"), "甲是乙年长的女性表亲（母系或姑舅姨同辈）", setOf("表姊")),
        hard("lover_of", "恋人", Direction.Undirected, "双方明确是恋爱或情侣关系；单方面爱慕不算", setOf("情侣", "恋爱")),
        hard("engaged_to", "婚约", Direction.Undirected, "双方订有婚约，尚未成婚", setOf("订婚", "未婚夫妻", "未婚夫", "未婚妻")),
        hard("mentor_of", "师徒", dir("师傅", "徒弟"), "甲与乙有明确师承；拒绝拜师或偶尔请教不成立", setOf("师父", "师傅"), setOf("徒弟", "弟子", "徒儿", "门徒")),
    )

    /** 宽泛亲属兜底（硬）：原文信息不足以细分时才使用，不得把已有的精确信息降级成它们。 */
    private fun fallbackKinship(): List<RelationType> = listOf(
        hard("spouse_of", "夫妻", Direction.Undirected, "双方已结婚，但无法或无需区分丈夫 / 妻子", setOf("配偶")),
        hard("parent_of", "亲子", dir("父母", "子女"), "甲是乙的生父或生母，但性别信息不足；养育关系应单独表达", setOf("父子", "母子", "父女", "母女"), setOf("子女", "儿子", "女儿", "孩子")),
        hard("adoptive_parent_of", "养亲", dir("养父母", "养子女"), "收养或养育关系，但信息不足以区分养父 / 养母", setOf("养父母"), setOf("养子", "养女")),
        hard("sibling_of", "兄弟姐妹", Direction.Undirected, "双方是兄弟姐妹，但无法确定长幼与性别", setOf("兄妹", "兄弟", "姐妹", "姐弟", "手足")),
        hard("grandparent_of", "祖孙", dir("祖辈", "孙辈"), "祖孙关系，但父系 / 母系或性别不明确", setOf("祖辈"), setOf("孙子", "孙女", "外孙", "外孙女")),
        hard("uncle_aunt_of", "叔侄", dir("长辈", "晚辈"), "隔一代的旁系近亲（叔侄、舅甥、姑侄、姨甥等），具体支系不明确", setOf("舅甥", "姑侄", "姨甥", "伯侄"), setOf("侄子", "侄女", "外甥", "外甥女")),
        hard("cousin_of", "堂表亲", Direction.Undirected, "同辈堂亲或表亲，无法进一步判断堂 / 表、长幼与性别；不含叔侄、舅甥", setOf("表亲", "堂亲", "堂兄弟", "表兄弟", "堂姐妹", "表姐妹")),
    )

    /** 中关系：有稳定剧情意义，展示次于硬关系。 */
    private fun strongSocial(): List<RelationType> = listOf(
        medium("romantic_interest_in", "单恋", dir("倾慕者", "被倾慕者"), "甲单方面爱慕乙；不等于恋人", setOf("暗恋", "倾慕")),
        medium("master_of", "主仆", dir("主人", "仆从"), "甲是乙的主人，乙是其仆从", setOf("主人"), setOf("仆从", "仆人", "奴仆")),
        medium("superior_of", "上下级", dir("上级", "下级"), "甲在组织中是乙的上级", setOf("上级"), setOf("下级", "下属")),
        medium("employer_of", "雇佣", dir("雇主", "雇员"), "甲雇佣乙，双方为雇主与雇员", setOf("雇主"), setOf("雇员")),
        medium("sovereign_subject_of", "君臣", dir("君主", "臣子"), "甲是乙的君主，乙是其臣子", setOf("君主"), setOf("臣子", "臣下")),
        medium("teacher_student_of", "师生", dir("老师", "学生"), "甲是乙的老师（教学关系，非正式师承）", setOf("老师"), setOf("学生")),
        medium("colleague_of", "同事", Direction.Undirected, "双方稳定共事"),
        medium("business_partner_of", "商业伙伴", Direction.Undirected, "双方有商业合作关系", setOf("合伙人", "生意伙伴")),
        medium("classmate_of", "同学", Direction.Undirected, "双方有共同就学的同学身份"),
        medium("fellow_disciple_of", "同门", Direction.Undirected, "双方出自同一师承或门派", setOf("师兄弟", "师姐妹", "师兄", "师姐", "师弟", "师妹")),
        medium("ally_of", "结盟", Direction.Undirected, "双方已建立联盟", setOf("盟友")),
        medium("enemy_of", "敌对", Direction.Undirected, "双方明确互为敌对对象", setOf("敌人", "仇敌")),
        medium("rival_of", "对手", Direction.Undirected, "双方互相竞争，不必达到敌对", setOf("竞争对手")),
        medium("protector_of", "保护", dir("保护者", "被保护者"), "甲对乙有稳定的保护职责或行为", setOf("保护者"), setOf("被保护者")),
        medium("benefactor_of", "恩人", dir("恩人", "受恩者"), "甲对乙有重大帮助或恩惠", setOf("救命恩人"), setOf("受恩者")),
        medium("guardian_of", "监护", dir("监护人", "被监护人"), "甲是乙的监护人（非生父母或养父母）", setOf("监护人"), setOf("被监护人")),
        medium("companion_of", "同行", Direction.Undirected, "双方稳定同行或搭档", setOf("搭档", "同伴", "旅伴")),
        medium("comrade_of", "战友", Direction.Undirected, "双方并肩作战或同属一个战斗集体"),
        medium("in_law_of", "姻亲", Direction.Undirected, "因婚姻形成的亲属（岳父母、公婆、女婿、儿媳、姐夫等），方向不加区分", setOf("岳父", "岳母", "公婆", "女婿", "儿媳", "亲家", "妯娌", "连襟")),
        medium("ex_spouse_of", "前任", Direction.Undirected, "双方曾是夫妻，现已离异或婚姻已终止", setOf("前夫", "前妻", "离异")),
        medium("sworn_sibling_of", "结拜", Direction.Undirected, "双方结拜为兄弟姐妹，非血缘手足", setOf("义兄弟", "结拜兄弟", "义结金兰")),
        medium("close_friend_of", "挚友", Direction.Undirected, "文本明确表现双方长期、深厚、彼此知心的友谊；只是相处融洽、一次相助或短期交好不算", setOf("知己", "至交", "密友", "莫逆之交")),
        medium("sworn_kin_of", "义亲", dir("义父母", "义子女"), "双方通过认干亲、拜义父义母等方式结成亲属般的关系，非血缘、非收养；结拜兄弟姐妹另见「结拜」", setOf("义父", "义母", "干爹", "干妈", "干娘", "干亲"), setOf("义子", "义女", "干儿子", "干女儿")),
    )

    /** 软关系：粗粒度兜底，具体标签不得超出依据。 */
    private fun softSocial(): List<RelationType> = listOf(
        soft("friend_of", "朋友", "双方有明确的友谊", setOf("友人", "好友")),
        soft("acquaintance_of", "相识", "双方相互认识，但没有足够依据证明更具体的关系", setOf("认识")),
        soft("neighbor_of", "邻居", "双方是邻居"),
        soft("fellow_townsman_of", "同乡", "双方来自同一地方"),
        soft("interacts_with", "互动", "双方在正文中确有实际交流，不能只凭同框推断", setOf("同场互动")),
    )
}
