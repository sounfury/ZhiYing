// 章阅读工具定义：名称、描述、参数 JSON Schema，以及「解析入参 -> 调用会话 -> 序列化结果」的薄封装。
// 业务校验全部在 ChapterSession 中；这里不做任何判断，入参无法解析时返回结构化错误。
package com.zhiying.infrastructure.llm.reading

import com.zhiying.infrastructure.llm.LlmJson
import org.springframework.ai.tool.ToolCallback
import org.springframework.ai.tool.definition.ToolDefinition

/** 章阅读工具集。 */
internal object ChapterTools {

    /** 为一个会话生成全部工具回调。 */
    fun of(session: ChapterSession): List<ToolCallback> = listOf(
        tool<ReadArgs>("read_chapter", "按字符偏移读取本章正文的一窗。长章必须逐窗读完。", READ_SCHEMA) { session.read(it.offset, it.limit) },
        tool<SearchArgs>("search_chapter", "在本章正文搜索关键词，返回命中处的 offset 与所在段落片段（最多 50 处）。", SEARCH_SCHEMA) { session.search(it.keyword) },
        tool<RosterArgs>("query_roster", "查询人名册；name 为空列出名册，否则按名称检索候选。同名不等于同一人。", ROSTER_SCHEMA) { session.queryRoster(it.name) },
        tool<PersonsArgs>("register_persons", "批量登记本章出场人物及其名称，返回 local_id。可用已有 local_id 补充名称或指向名册 ID。", PERSONS_SCHEMA) {
            session.registerPersons(it.persons.orEmpty())
        },
        tool<RelationsArgs>("submit_relations", "批量提交关系候选及首次判断。每条独立校验，被拒的按错误修正后重提。", RELATIONS_SCHEMA) {
            session.submitRelations(it.relations.orEmpty())
        },
        tool<InteractionsArgs>("submit_interactions", "批量提交两个人物之间的实际交流观察。不要把交流命名为关系。", INTERACTIONS_SCHEMA) {
            session.submitInteractions(it.interactions.orEmpty())
        },
        tool<SubmitArgs>("submit_result", "提交本章摘要并结束阅读。这是最后一步，不调用则本章没有结果。", SUBMIT_SCHEMA) { session.submit(it.summary) },
    )

    /** 构造一个工具：入参按 snake_case 解析为 [I]，解析失败返回 INVALID_ARGUMENTS，结果序列化为 JSON。 */
    private inline fun <reified I : Any> tool(
        name: String,
        description: String,
        schema: String,
        crossinline handler: (I) -> Map<String, Any?>,
    ): ToolCallback = object : ToolCallback {
        private val definition = ToolDefinition.builder().name(name).description(description).inputSchema(schema).build()

        override fun getToolDefinition(): ToolDefinition = definition

        override fun call(toolInput: String): String {
            val args = try {
                LlmJson.toolMapper.readValue(toolInput.ifBlank { "{}" }, I::class.java)
            } catch (e: Exception) {
                val error = mapOf("code" to "INVALID_ARGUMENTS", "message" to "参数不是合法 JSON 或类型不符：${e.message?.take(ERROR_MAX_CHARS)}")
                return LlmJson.write(mapOf("status" to "error", "errors" to listOf(error)))
            }
            return LlmJson.write(handler(args))
        }
    }

    private const val ERROR_MAX_CHARS = 200

    private val READ_SCHEMA = """
{"type":"object","properties":{
 "offset":{"type":"integer","description":"起始字符位置，从 0 起"},
 "limit":{"type":"integer","description":"期望读取的字符数，超过每窗上限会被截断"}},
 "required":["offset"]}
""".trimIndent()

    private val SEARCH_SCHEMA = """
{"type":"object","properties":{"keyword":{"type":"string","description":"要搜索的关键词"}},"required":["keyword"]}
""".trimIndent()

    private val ROSTER_SCHEMA = """
{"type":"object","properties":{"name":{"type":"string","description":"按名称检索；留空列出名册"}}}
""".trimIndent()

    private val PERSONS_SCHEMA = """
{"type":"object","properties":{"persons":{"type":"array","items":{"type":"object","properties":{
 "local_id":{"type":"string","description":"已登记的本章局部编号；填写表示补充名称或更新，不填表示新人物"},
 "existing_person_id":{"type":"string","description":"仅当正文足以确定是同一人时，填人名册里的人物 ID"},
 "names":{"type":"array","items":{"type":"object","properties":{
  "name":{"type":"string"},
  "kind":{"type":"string","enum":["formal","alias","stable_appellation","context_only"]},
  "basis":{"type":"string","description":"该名称归属于此人的依据，可省略沿用条目 basis"}},
  "required":["name","kind"]}},
 "basis":{"type":"string","description":"新人物必填：身份判断的简短理由（是新人还是名册中的谁）"},
 "profile":{"type":"string","description":"本章简介（身份、与主角的关系、本章做了什么，20~60 字）；新人物若参与关系候选则必填，其他人物有依据再填"},
 "gender":{"type":"string","enum":["male","female","unknown"]},
 "importance":{"type":"string","enum":["protagonist","supporting","minor"]}}}}},
 "required":["persons"]}
""".trimIndent()

    private val EVIDENCE_ITEM = """
{"type":"array","minItems":1,"items":{"type":"object","properties":{
 "note":{"type":"string","description":"一句话说明依据（必填）"},
 "quote":{"type":"string","description":"本章里逐字一致的连续原句（可选）"},
 "at":{"type":"integer","description":"quote 在正文中出现多次时，填该句起始 offset"}},
 "required":["note"]}}
""".trimIndent()

    private val RELATIONS_SCHEMA = """
{"type":"object","properties":{"relations":{"type":"array","items":{"type":"object","properties":{
 "source":{"type":"string","description":"local_id；有向类型时为承担源端角色的人"},
 "target":{"type":"string","description":"local_id；有向类型时为承担目标端角色的人"},
 "type_id":{"type":"string","description":"类型库中的类型 ID（与 new_type 二选一）"},
 "new_type":{"type":"object","description":"类型库没有合适类型时的新类型建议","properties":{
  "name":{"type":"string"},"definition":{"type":"string","description":"一般性定义，不写具体人名"},
  "hardness":{"type":"string","enum":["hard","medium","soft"]},
  "directed":{"type":"boolean"},"source_role":{"type":"string"},"target_role":{"type":"string"}}},
 "description":{"type":"string","description":"原文所表达的具体关系，保留方向和细节"},
 "evidence":$EVIDENCE_ITEM,
 "verdict":{"type":"string","enum":["supported","undetermined","refuted"]},
 "undetermined_reason":{"type":"string","enum":["unclear_reference","ambiguous_type_or_direction","insufficient_context","figurative_or_hearsay"]},
 "assessment_basis":{"type":"string","description":"首次判断的依据"}},
 "required":["source","target","description","evidence","verdict","assessment_basis"]}}},
 "required":["relations"]}
""".trimIndent()

    private val INTERACTIONS_SCHEMA = """
{"type":"object","properties":{"interactions":{"type":"array","items":{"type":"object","properties":{
 "person_a":{"type":"string"},"person_b":{"type":"string"},
 "description":{"type":"string","description":"发生了什么交流（对话、书信、共同行动等），不要命名为关系"},
 "note":{"type":"string","description":"依据说明，省略则沿用 description"},
 "quote":{"type":"string","description":"逐字一致的原句（可选）"},
 "at":{"type":"integer","description":"quote 出现多次时的起始 offset"}},
 "required":["person_a","person_b","description"]}}},
 "required":["interactions"]}
""".trimIndent()

    private val SUBMIT_SCHEMA = """
{"type":"object","properties":{"summary":{"type":"string","description":"1~3 句话的本章摘要"}},"required":["summary"]}
""".trimIndent()
}
