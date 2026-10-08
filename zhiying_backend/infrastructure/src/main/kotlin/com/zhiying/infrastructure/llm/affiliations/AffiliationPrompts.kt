// 团体归纳的提示词与输入渲染：规则照搬旧后端 faction 提示词，并按新设计区分团体事实与布局推断。
package com.zhiying.infrastructure.llm.affiliations

import com.zhiying.application.analyze.affiliations.AffiliationRequest
import com.zhiying.application.analyze.affiliations.InductionPerson
import com.zhiying.domain.identity.Importance
import com.zhiying.domain.identity.PersonId
import com.zhiying.infrastructure.llm.analysis.AnalysisPromptText

/** 团体归纳提示词版本；提示词或输出格式变化时递增。 */
// v2：人物改用短代号（P1、P2……），长 ID 常被模型抄错导致整份回复被拒
internal const val AFFILIATION_PROMPT_VERSION = "affiliation-v2"

/** 团体类别取值；仅用于约束模型命名，不影响结果存储。 */
internal val AFFILIATION_KINDS = setOf("school", "religious", "family", "organization", "movement", "stage", "other")

/** 团体归纳提示词渲染。 */
internal object AffiliationPrompts {

    /** 系统提示：团体语义、类别、分块要求与输出约定。[minGroups]、[maxGroups] 为建议团体数范围。 */
    fun system(minGroups: Int, maxGroups: Int): String = """
你是一名小说人物「团体（势力）」归纳助手。你的任务是根据全书人名册、章摘要与关系骨架，列出书中真实存在的团体及其成员，供关系图按团体分区。

## 什么叫团体

团体 = 人物所属的聚合：一群人因共同机构、场景世界、组织身份或稳定归属而聚在一起。

算团体的例子：学校 / 年级阶段（小学、中学、大学）、宗教与教会、组织机构（公司、门派、军队、学院）、家族作为团体块、政治或意识形态阵营、某一阶段的生活世界。

不算团体（这些是关系边，不是团体）：
- 两人之间的关系类型：朋友、同学、亲子、师徒、相识、同场……
- 亲疏强弱（和主角第几档亲）
- 单次同场

绝对禁止把「朋友」「同学」「相识」「亲人」「主角的朋友们」这类关系词当团体名。「小学朋友」和「大学朋友」线相同、团体不同，正确的团体名是学校名，不是「朋友」。

## 团体事实与布局推断

你只提交团体事实：有章摘要、关系骨架或章内观察支撑的归属。为了把图摆得好看而凑的分块不是事实；找不到依据的人物就不要归入任何团体，布局阶段会另行推断，不要为了覆盖率编造归属。

## kind 取值（必须取其中之一）

- school       学校 / 年级阶段
- religious    宗教 / 教会 / 修会 / 神职圈
- family       家族作团体块（血缘细节仍由关系边表达）
- organization 公司 / 军队 / 门派 / 机构 / 学院
- movement     政治 / 意识形态 / 民族主义等主张型圈子
- stage        书中确有明确划分的叙事阶段世界（「第 N 阶段」）；实在抽不出机构时才用
- other        以上都不合适

## 分团要求

1. 团体数建议在 $minGroups-$maxGroups 个：太少等于没分区，太多等于没秩序；书里确实只有更少时按实际来。
2. 团体名用书里的专有名词（学校名、教会名、家族名、圈子名），不要用「一群人」「配角们」。
3. 一人可属多个团体（主角常跨多个阶段）；不要为了唯一归属而漏掉真实归属，也不要强行只归一个。
4. chapters 填该人在此团体活跃的章号（阅读序号）。阶段性团体（某学校）只在对应章活跃，这样按前 N 章看图时后期团体不会提前泄露。
5. personId 填人名册里每人行首的代号（如 P3），不要编造，也不要改写成名字。
6. 每个成员尽量给出 note（归属依据，一句话），有原文短句时填 quote。

## 输出

只输出一个 JSON 对象，团体放在 groups 数组里：name（必填）、kind（必填）、note（可选，一句话说明团体）、members（必填，非空，每项含 personId、role 可选、chapters、note、quote）。
""".trimIndent()

    /** 人名册里每人的短代号，按名册顺序编号；提示与回复解析共用。 */
    fun refs(request: AffiliationRequest): Map<PersonId, String> =
        request.persons.withIndex().associate { (i, p) -> p.person.id to AnalysisPromptText.personRef(i) }

    /** 用户提示：人名册、章摘要与观察、关系骨架；人物一律用短代号指称。 */
    fun user(request: AffiliationRequest): String {
        val names = request.persons.associate { it.person.id to it.person.displayName }
        val refs = refs(request)
        val chapterRange = request.chapters.takeIf { it.isNotEmpty() }
            ?.let { "第 ${it.first().number}-${it.last().number} 章（共 ${it.size} 章）" } ?: "无"
        return buildString {
            appendLine("## 已分析章范围\n- $chapterRange\n")
            appendLine("## 人名册（共 ${request.persons.size} 人，后面括号内为出场章号）")
            request.persons.forEach { appendLine(rosterLine(it, refs.getValue(it.person.id))) }
            appendLine("\n## 各章摘要与章内观察")
            if (request.chapters.isEmpty()) appendLine("（无章摘要）")
            request.chapters.forEach { c ->
                appendLine("  - 第 ${c.number} 章: ${c.summary}")
                c.observations.forEach { appendLine("      · 观察: $it") }
            }
            appendLine("\n## 关系骨架（已验证的具体关系）")
            if (request.relations.isEmpty()) appendLine("（无已验证关系边）")
            request.relations.forEach { r ->
                val a = names[r.first] ?: r.first.value
                val b = names[r.second] ?: r.second.value
                val ra = refs[r.first] ?: r.first.value
                val rb = refs[r.second] ?: r.second.value
                appendLine("  - $ra $a — $rb $b: ${r.typeName} (ch ${r.chapters.joinToString(",")})")
            }
            appendLine("\n## 任务")
            appendLine("1. 通读人名册与章摘要，识别书中真实存在的机构 / 教会 / 家族 / 学校 / 圈子。")
            appendLine("2. 把有依据的人物归入团体，一人可多归属；没有依据的人物不要硬归。")
            appendLine("3. 一次性输出全部团体。")
        }
    }

    /** 一行人名册：短代号、名、别名、重要度、资料与出场章。 */
    private fun rosterLine(p: InductionPerson, ref: String): String {
        val person = p.person
        val aliases = person.aliases.takeIf { it.isNotEmpty() }?.joinToString("/", prefix = " 别名[", postfix = "]").orEmpty()
        val importance = when (person.importance) {
            Importance.PROTAGONIST -> "主角"
            Importance.SUPPORTING -> "配角"
            else -> "次要"
        }
        val profile = person.profile?.takeIf { it.isNotBlank() }?.let { " — $it" }.orEmpty()
        return "  - $ref: ${person.displayName}$aliases [$importance]$profile (${ranges(p.appearances)})"
    }

    /** 章号压缩成区间写法：1-5,8,10-12。 */
    private fun ranges(numbers: List<Int>): String {
        if (numbers.isEmpty()) return "无"
        val parts = mutableListOf<String>()
        var start = numbers.first()
        var prev = start
        for (n in numbers.drop(1) + (numbers.last() + 2)) {
            if (n == prev + 1) { prev = n; continue }
            parts += if (start == prev) "$start" else "$start-$prev"
            start = n
            prev = n
        }
        return parts.joinToString(",")
    }
}
