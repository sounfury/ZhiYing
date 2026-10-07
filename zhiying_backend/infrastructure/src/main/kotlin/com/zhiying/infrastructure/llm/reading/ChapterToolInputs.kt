// 章阅读工具的入参 DTO：字段名与工具 JSON 的 snake_case 一一对应，全部可空，缺字段由会话校验后以结构化错误反馈。
package com.zhiying.infrastructure.llm.reading

/** 名称：kind 为 formal / alias / stable_appellation / context_only。 */
internal data class NameInput(val name: String? = null, val kind: String? = null, val basis: String? = null)

/** 人物登记条目：新人物不填 localId；补充名称或指向名册 ID 时填已有 localId。 */
internal data class PersonInput(
    val localId: String? = null,
    val existingPersonId: String? = null,
    val names: List<NameInput>? = null,
    val basis: String? = null,
    val profile: String? = null,
    val gender: String? = null,
    val importance: String? = null,
)

/** 依据：说明必填，引文可选，同一句多处出现时用 at 选定。 */
internal data class EvidenceInput(val note: String? = null, val quote: String? = null, val at: Int? = null)

/** 新类型建议。 */
internal data class NewTypeInput(
    val name: String? = null,
    val definition: String? = null,
    val hardness: String? = null,
    val directed: Boolean? = null,
    val sourceRole: String? = null,
    val targetRole: String? = null,
)

/** 关系候选及章内首次判断。 */
internal data class RelationInput(
    val source: String? = null,
    val target: String? = null,
    val typeId: String? = null,
    val newType: NewTypeInput? = null,
    val description: String? = null,
    val evidence: List<EvidenceInput>? = null,
    val verdict: String? = null,
    val undeterminedReason: String? = null,
    val assessmentBasis: String? = null,
)

/** 交流观察。 */
internal data class InteractionInput(
    val personA: String? = null,
    val personB: String? = null,
    val description: String? = null,
    val note: String? = null,
    val quote: String? = null,
    val at: Int? = null,
)

/** read_chapter 参数。 */
internal data class ReadArgs(val offset: Int? = null, val limit: Int? = null)

/** search_chapter 参数。 */
internal data class SearchArgs(val keyword: String? = null)

/** query_roster 参数。 */
internal data class RosterArgs(val name: String? = null)

/** register_persons 参数。 */
internal data class PersonsArgs(val persons: List<PersonInput>? = null)

/** submit_relations 参数。 */
internal data class RelationsArgs(val relations: List<RelationInput>? = null)

/** submit_interactions 参数。 */
internal data class InteractionsArgs(val interactions: List<InteractionInput>? = null)

/** submit_result 参数。 */
internal data class SubmitArgs(val summary: String? = null)
