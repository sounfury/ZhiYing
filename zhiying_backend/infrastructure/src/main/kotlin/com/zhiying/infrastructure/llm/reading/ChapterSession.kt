// 本章会话：持有一章阅读过程中的全部状态（已读范围、局部人物、已接受的关系候选与交流观察），
// 并在会话内校验人物编号、正文区间与引文；工具回调只做 JSON 与 DTO 转换，规则都在这里。
// 校验失败返回结构化错误（code + message），让模型在本轮修正；会话最终产出领域对象 ChapterExtraction。
package com.zhiying.infrastructure.llm.reading

import com.zhiying.domain.extraction.ChapterExtraction
import com.zhiying.domain.extraction.ChapterSummary
import com.zhiying.domain.extraction.ExtractionId
import com.zhiying.domain.extraction.ExtractionProvenance
import com.zhiying.domain.identity.Gender
import com.zhiying.domain.identity.IdentityClaim
import com.zhiying.domain.identity.Importance
import com.zhiying.domain.identity.LocalPersonRef
import com.zhiying.domain.identity.MentionId
import com.zhiying.domain.identity.NameIndex
import com.zhiying.domain.identity.NameKind
import com.zhiying.domain.identity.Person
import com.zhiying.domain.identity.PersonId
import com.zhiying.domain.identity.PersonMention
import com.zhiying.domain.library.Chapter
import com.zhiying.domain.library.EvidenceId
import com.zhiying.domain.library.EvidenceRef
import com.zhiying.domain.library.ExcerptLookup
import com.zhiying.domain.library.TextSpan
import com.zhiying.domain.relations.AssessmentSource
import com.zhiying.domain.relations.CandidateId
import com.zhiying.domain.relations.Direction
import com.zhiying.domain.relations.Hardness
import com.zhiying.domain.relations.InteractionId
import com.zhiying.domain.relations.InteractionObservation
import com.zhiying.domain.relations.RelationAssessment
import com.zhiying.domain.relations.RelationCandidate
import com.zhiying.domain.relations.RelationTypeId
import com.zhiying.domain.relations.RelationTypeLibrary
import com.zhiying.domain.relations.SemanticVerdict
import com.zhiying.domain.relations.TypeProposal
import com.zhiying.domain.relations.TypeReference
import com.zhiying.domain.relations.UndeterminedReason
import java.util.UUID

/** 工具边界上的一条结构化错误，返回给模型用于修正。 */
internal data class ToolError(val code: String, val message: String, val field: String? = null) {
    /** 转成返回给模型的 JSON 对象。 */
    fun toMap(): Map<String, Any?> = listOfNotNull(
        "code" to code,
        field?.let { "field" to it },
        "message" to message,
    ).toMap()
}

/** 章内某个局部人物的累积状态；各名称对应一条提及。 */
private class LocalPerson(val ref: LocalPersonRef, var existing: PersonId?, var basis: String) {
    var profile: String? = null
    var gender: Gender = Gender.UNKNOWN
    var importance: Importance? = null
    val mentions = mutableListOf<PersonMention>()

    /** 转成对该局部人物的身份主张。 */
    fun claim() = IdentityClaim(ref, existing, basis, profile, gender, importance)
}

/** 校验通过后的名称输入。 */
private class ParsedName(val name: String, val stableKind: NameKind?, val basis: String?)

/** 校验通过后的关系类型：引用与硬度。 */
private class ResolvedType(val ref: TypeReference, val hardness: Hardness, val direction: Direction)

/** 单条关系候选的处理结果。 */
private sealed interface RelationOutcome {
    data class Accepted(
        val candidate: RelationCandidate,
        val assessment: RelationAssessment,
        val recordedAs: String?,
    ) : RelationOutcome
    data class Rejected(val errors: List<ToolError>) : RelationOutcome
    data class Skipped(val error: ToolError) : RelationOutcome
}

/**
 * 一章的阅读会话。
 *
 * 入参：[chapter] 本章；[roster] 人名册快照（只读）；[library] 关系类型库；
 * [readWindowChars] 分段读取每窗上限；[unit] 本会话负责抽取的区间（长章的一段），读取与搜索仍覆盖整章；
 * [injectedUnitText] 本单元正文是否已注入提示（视为已读完）。
 * 会话只在单线程的工具循环内使用，没有全库写权限。
 */
internal class ChapterSession(
    private val chapter: Chapter,
    private val roster: List<Person>,
    private val library: RelationTypeLibrary,
    private val readWindowChars: Int,
    private val unit: IntRange,
    injectedUnitText: Boolean,
) {
    private val nameIndex = NameIndex.of(roster)
    private val rosterIds = roster.mapTo(mutableSetOf()) { it.id }
    private val locals = LinkedHashMap<String, LocalPerson>()
    private val candidates = mutableListOf<RelationCandidate>()
    private val assessments = mutableListOf<RelationAssessment>()
    private val interactions = mutableListOf<InteractionObservation>()
    private val strongPairs = mutableSetOf<Set<String>>()
    private val readRanges = mutableListOf<IntRange>()
    private var mentionSeq = 0
    private var evidenceSeq = 0
    private var candidateSeq = 0
    private var unreadWarned = false
    private var profileRejects = 0

    /** 是否已成功提交本章结果。 */
    var submitted = false
        private set

    private var summary: String = ""
    private val warnings = mutableListOf<String>()

    init {
        if (injectedUnitText) readRanges += unit
    }

    /** 是否已经登记过人物或提交过观察（用于模型停手时的收尾判断）。 */
    fun hasWork(): Boolean = locals.isNotEmpty() || candidates.isNotEmpty() || interactions.isNotEmpty()

    /** 本章阅读过程中产生的非致命警告。 */
    fun warnings(): List<String> = warnings.toList()

    // ───────────────────────── 读取与搜索 ─────────────────────────

    /**
     * 按字符偏移读取一窗正文，并记录已读范围。
     *
     * 入参：[offset] 起点（UTF-16 字符位置，从 0 起）；[limit] 期望长度，超出每窗上限时截断。
     * 出参：窗内文本与 has_more；参数不合法时返回结构化错误。
     */
    fun read(offset: Int?, limit: Int?): Map<String, Any?> {
        val total = chapter.text.length
        val start = offset ?: 0
        if (start < 0 || start >= total) {
            return failure(ToolError("INVALID_RANGE", "offset 必须在 0 到 ${total - 1} 之间，当前 $start；正文共 $total 字符", "offset"))
        }
        val size = (limit ?: readWindowChars).coerceIn(1, readWindowChars)
        val unitEnd = unit.last + 1
        // 单元内的窗口不越过单元末尾；单元之外只在模型主动要求时才读（用于核对上下文）
        var end = minOf(start + size, total, if (start < unitEnd) unitEnd else total)
        if (end < total && chapter.text[end].isLowSurrogate()) end-- // 不切开补充平面字符
        readRanges += start until end
        return mapOf(
            "offset" to start,
            "end" to end,
            "total_chars" to total,
            "unit_start" to unit.first,
            "unit_end" to unitEnd,
            "has_more" to (end < unitEnd),
            "next_offset" to end,
            "text" to chapter.text.substring(start, end),
        )
    }

    /**
     * 在本章搜索关键词，返回每处命中的位置与所在段落的片段（最多 [MAX_MATCHES] 处）。
     *
     * 出参：命中列表，offset 是命中处的字符位置，可作为引文的 at。
     */
    fun search(keyword: String?): Map<String, Any?> {
        val key = keyword?.trim().orEmpty()
        if (key.isEmpty()) return failure(ToolError("MISSING_KEYWORD", "keyword 不能为空", "keyword"))
        val hits = generateSequence(chapter.text.indexOf(key).takeIf { it >= 0 }) { prev ->
            chapter.text.indexOf(key, prev + 1).takeIf { it >= 0 }
        }.toList()
        val shown = hits.take(MAX_MATCHES).map { mapOf("offset" to it, "snippet" to snippetAround(it, key.length)) }
        return mapOf("total_matches" to hits.size, "truncated" to (hits.size > MAX_MATCHES), "matches" to shown)
    }

    /** 取命中处前后各 [SNIPPET_RADIUS] 字符的片段，不跨出所在段落。 */
    private fun snippetAround(index: Int, length: Int): String {
        val text = chapter.text
        val lineStart = text.lastIndexOf('\n', index).let { if (it < 0) 0 else it + 1 }
        val lineEnd = text.indexOf('\n', index).let { if (it < 0) text.length else it }
        val from = maxOf(lineStart, index - SNIPPET_RADIUS)
        val to = minOf(lineEnd, index + length + SNIPPET_RADIUS)
        return text.substring(from, to)
    }

    /** 本单元内尚未读到的区间（相邻已读范围合并后取补集）；单元之外的内容读没读都不计。 */
    private fun unreadRanges(): List<IntRange> {
        val end = unit.last + 1
        var cursor = unit.first
        val gaps = mutableListOf<IntRange>()
        for (range in readRanges.sortedBy { it.first }) {
            if (range.first > cursor && cursor < end) gaps += cursor until minOf(range.first, end)
            cursor = maxOf(cursor, range.last + 1)
        }
        if (cursor < end) gaps += cursor until end
        return gaps
    }

    // ───────────────────────── 人名册与人物登记 ─────────────────────────

    /**
     * 查询人名册。
     *
     * 入参：[name] 为空时列出名册（最多 [ROSTER_LIST_LIMIT] 人），否则按名称检索；
     * 精确同名者排在前面，其次是名称互相包含者。同时返回本章已登记的局部人物。
     */
    fun queryRoster(name: String?): Map<String, Any?> {
        val key = name?.trim().orEmpty()
        val exact = nameIndex.candidates(key)
        val matched = if (key.isEmpty()) {
            roster
        } else {
            roster.filter { it.id in exact } +
                roster.filter { p -> p.id !in exact && p.names.any { key in it || it in key } }
        }
        return mapOf(
            "persons" to matched.take(ROSTER_LIST_LIMIT).map { p ->
                mapOf("person_id" to p.id.value, "name" to p.displayName, "aliases" to p.aliases, "profile" to p.profile)
            },
            "registered_in_chapter" to locals.values.map { l ->
                mapOf(
                    "local_id" to l.ref.key,
                    "names" to l.mentions.map { it.name },
                    "existing_person_id" to l.existing?.value,
                )
            },
        )
    }

    /**
     * 批量登记本章人物及其名称；每个条目独立校验，通过的立即生效，被拒的返回错误。
     *
     * 出参：每条的 local_id、状态以及名称命中的名册候选（名称命中不等于同一人）。
     */
    fun registerPersons(items: List<PersonInput>): Map<String, Any?> {
        val results = items.mapIndexed { index, item -> registerOne(index, item) }
        return mapOf("status" to overallStatus(results), "results" to results)
    }

    /** 登记或补充单个人物；流程：校验名称与名册 ID → 找到或新建局部人物 → 追加提及 → 返回名册候选提示。 */
    private fun registerOne(index: Int, item: PersonInput): Map<String, Any?> {
        val errors = mutableListOf<ToolError>()
        val names = parseNames(item, errors)
        val existing = item.existingPersonId?.trim()?.takeIf { it.isNotEmpty() }?.let { raw ->
            PersonId(raw).also { if (it !in rosterIds) errors += ToolError("UNKNOWN_ROSTER_ID", "人名册中没有 $raw", "existing_person_id") }
        }
        val known = item.localId?.let { id ->
            locals[id] ?: null.also { errors += ToolError("UNKNOWN_LOCAL_ID", "本章尚未登记 local_id=$id", "local_id") }
        }
        if (known == null && item.localId == null && item.basis.isNullOrBlank()) {
            errors += ToolError("MISSING_BASIS", "新登记人物必须用 basis 说明身份判断的依据", "basis")
        }
        if (errors.isNotEmpty()) return rejected(index, errors)
        val local = known ?: newLocal(existing, item.basis.orEmpty())
        applyProfile(local, item, existing)
        val added = names.filter { n -> local.mentions.none { it.name == n.name && it.stableKind == n.stableKind } }
        added.forEach { n -> local.mentions += mention(local, n, item.basis.orEmpty()) }
        return mapOf(
            "index" to index,
            "status" to if (known == null) "registered" else "updated",
            "local_id" to local.ref.key,
            "name_matches" to nameMatches(names, local.existing),
        )
    }

    /** 新建局部人物，编号 p1、p2……。 */
    private fun newLocal(existing: PersonId?, basis: String): LocalPerson {
        val key = "p${locals.size + 1}"
        return LocalPerson(LocalPersonRef(chapter.id, key), existing, basis).also { locals[key] = it }
    }

    /** 把条目中提供的名册 ID 与人物资料写入局部人物；资料只补充、不清空。 */
    private fun applyProfile(local: LocalPerson, item: PersonInput, existing: PersonId?) {
        existing?.let { local.existing = it }
        if (item.localId != null && !item.basis.isNullOrBlank()) local.basis = item.basis
        item.profile?.takeIf { it.isNotBlank() }?.let { local.profile = it }
        parseGender(item.gender)?.let { local.gender = it }
        parseImportance(item.importance)?.let { local.importance = it }
    }

    /** 为一个名称生成提及；名称自身的依据优先，否则沿用条目依据。 */
    private fun mention(local: LocalPerson, name: ParsedName, itemBasis: String): PersonMention =
        PersonMention(
            MentionId("${chapter.id.value}-m${++mentionSeq}"),
            local.ref,
            name.name,
            name.stableKind,
            name.basis ?: itemBasis.ifBlank { local.basis },
        )

    /** 校验并解析名称列表：非空、名称非空、kind 合法。 */
    private fun parseNames(item: PersonInput, errors: MutableList<ToolError>): List<ParsedName> {
        val raw = item.names.orEmpty()
        if (raw.isEmpty() && item.localId == null) errors += ToolError("MISSING_NAMES", "新登记人物至少给出一个名称", "names")
        return raw.mapIndexedNotNull { i, n ->
            val name = n.name?.trim().orEmpty()
            val kind = n.kind?.trim()?.lowercase()
            when {
                name.isEmpty() -> null.also { errors += ToolError("EMPTY_NAME", "names[$i].name 不能为空", "names[$i].name") }
                kind !in NAME_KINDS -> null.also {
                    errors += ToolError("INVALID_NAME_KIND", "names[$i].kind 只能是 ${NAME_KINDS.keys}，当前 $kind", "names[$i].kind")
                }
                else -> ParsedName(name, NAME_KINDS.getValue(kind), n.basis?.takeIf { it.isNotBlank() })
            }
        }
    }

    /** 名称命中名册的候选提示；命中不等于同一人，已指向名册 ID 的不再提示。 */
    private fun nameMatches(names: List<ParsedName>, claimed: PersonId?): List<Map<String, Any?>> =
        names.mapNotNull { n ->
            val hits = nameIndex.candidates(n.name).filter { it != claimed }
            if (hits.isEmpty()) {
                null
            } else {
                mapOf(
                    "name" to n.name,
                    "roster_candidates" to hits.map { it.value },
                    "note" to "名称相同不等于同一人；确认是同一人时，用 local_id 加 existing_person_id 补充，否则保持新人物",
                )
            }
        }

    private fun parseGender(raw: String?): Gender? = when (raw?.trim()?.lowercase()) {
        "male" -> Gender.MALE
        "female" -> Gender.FEMALE
        "unknown" -> Gender.UNKNOWN
        else -> null
    }

    private fun parseImportance(raw: String?): Importance? = when (raw?.trim()?.lowercase()) {
        "protagonist" -> Importance.PROTAGONIST
        "supporting" -> Importance.SUPPORTING
        "minor" -> Importance.MINOR
        else -> null
    }

    // ───────────────────────── 关系候选 ─────────────────────────

    /**
     * 批量提交关系候选；每条独立校验，通过的立即生效。
     *
     * 出参：每条的状态（accepted / rejected / skipped）与错误；已有硬 / 中关系的人物对再提交软关系会被跳过。
     */
    fun submitRelations(items: List<RelationInput>): Map<String, Any?> {
        val results = items.mapIndexed { index, item ->
            when (val outcome = relationOne(item)) {
                is RelationOutcome.Accepted -> {
                    candidates += outcome.candidate
                    assessments += outcome.assessment
                    listOfNotNull("index" to index, "status" to "accepted", outcome.recordedAs?.let { "recorded_as" to it }).toMap()
                }
                is RelationOutcome.Rejected -> rejected(index, outcome.errors)
                is RelationOutcome.Skipped -> mapOf("index" to index, "status" to "skipped", "reason" to outcome.error.toMap())
            }
        }
        return mapOf("status" to overallStatus(results), "results" to results)
    }

    /** 校验并构造单条候选；流程：端点 → 类型 → 描述 → 依据 → 首次判断 → 软关系冗余检查 → 重复检查。 */
    private fun relationOne(item: RelationInput): RelationOutcome {
        val errors = mutableListOf<ToolError>()
        val source = localRef(item.source, "source", errors)
        val target = localRef(item.target, "target", errors)
        if (source != null && source == target) errors += ToolError("SELF_RELATION", "source 与 target 不能是同一人物", "target")
        val type = resolveType(item, errors)
        val description = item.description?.trim().orEmpty()
        if (description.isEmpty()) errors += ToolError("MISSING_DESCRIPTION", "description 必须保留原文所述的关系描述", "description")
        val evidence = resolveEvidence(item.evidence, errors)
        val verdict = resolveVerdict(item, errors)
        if (errors.isNotEmpty() || source == null || target == null || type == null || verdict == null) {
            return RelationOutcome.Rejected(errors)
        }
        val pair = setOf(source.key, target.key)
        if (!type.hardness.strong && pair in strongPairs) {
            return RelationOutcome.Skipped(ToolError("SOFT_NOT_NEEDED", "该人物对已提交硬 / 中关系，无需再提交软关系"))
        }
        val candidate = RelationCandidate(newCandidateId(), source, target, type.ref, description, evidence)
        if (candidates.any { sameRelation(it, candidate) }) {
            return RelationOutcome.Skipped(ToolError("DUPLICATE", "已提交过相同的关系候选"))
        }
        withdrawReversed(candidate)
        if (type.hardness.strong) strongPairs += pair
        return RelationOutcome.Accepted(
            candidate,
            RelationAssessment(candidate.id, verdict, item.assessmentBasis.orEmpty().trim(), AssessmentSource.CHAPTER_READING),
            roleEcho(item, type.direction),
        )
    }

    /** 有向类型时回显两端被记录的角色（带人名），让模型当场核对方向有没有写反；无向类型无需回显。 */
    private fun roleEcho(item: RelationInput, direction: Direction): String? =
        (direction as? Direction.Directed)?.let {
            val source = nameOf(item.source)
            val target = nameOf(item.target)
            "已记录：$source 是「${it.sourceRole}」，$target 是「${it.targetRole}」。请核对这是否符合正文；" +
                "若写反了，用相反的 source/target 重新提交同一条，将替换原记录"
        }

    /** 局部人物的首个名称，用于回显。 */
    private fun nameOf(key: String?): String = locals[key?.trim()]?.mentions?.firstOrNull()?.name ?: key.orEmpty()

    private fun newCandidateId() = CandidateId("${chapter.id.value}-c${++candidateSeq}")

    /** 同一类型以相反的端点重新提交，视为对方向的更正：撤销旧记录（及其首次判断）。 */
    private fun withdrawReversed(candidate: RelationCandidate) {
        val old = candidates.firstOrNull {
            it.source == candidate.target && it.target == candidate.source && it.type == candidate.type
        } ?: return
        candidates.remove(old)
        assessments.removeAll { it.candidate == old.id }
    }

    /** 两条候选是否重复：同一对端点、同一类型引用、同一描述。 */
    private fun sameRelation(a: RelationCandidate, b: RelationCandidate): Boolean =
        a.source == b.source && a.target == b.target && a.type == b.type && a.description == b.description

    /** 解析局部人物编号；未登记的编号报错。 */
    private fun localRef(key: String?, field: String, errors: MutableList<ToolError>): LocalPersonRef? {
        val local = key?.trim()?.let { locals[it] }
        if (local == null) {
            errors += ToolError("UNKNOWN_PERSON", "$field=${key ?: "(空)"} 不是本章已登记的 local_id；先用 register_persons 登记", field)
        }
        return local?.ref
    }

    /** 解析关系类型：type_id 与 new_type 二选一；类型库已有的同名类型不允许当新类型提交。 */
    private fun resolveType(item: RelationInput, errors: MutableList<ToolError>): ResolvedType? {
        val typeId = item.typeId?.trim()?.takeIf { it.isNotEmpty() }
        val proposal = item.newType
        if ((typeId == null) == (proposal == null)) {
            errors += ToolError("TYPE_REQUIRED", "type_id 与 new_type 必须二选一", "type_id")
            return null
        }
        if (typeId != null) {
            // 模型有时填类型名而不是 ID，名称能唯一命中就接受
            val known = library[RelationTypeId(typeId)] ?: library.findByName(typeId)
            if (known == null) {
                errors += ToolError("UNKNOWN_TYPE", "类型库中没有 $typeId；请使用类型库列出的 type_id，确实没有合适类型再用 new_type", "type_id")
                return null
            }
            return ResolvedType(TypeReference.Known(known.id), known.hardness, known.direction)
        }
        return resolveProposal(proposal!!, errors)
    }

    /** 校验新类型建议：名称与定义必填、硬度合法、有向时给出两端角色，且不与类型库已有名称冲突。 */
    private fun resolveProposal(p: NewTypeInput, errors: MutableList<ToolError>): ResolvedType? {
        val before = errors.size
        val name = p.name?.trim().orEmpty()
        val definition = p.definition?.trim().orEmpty()
        if (name.isEmpty() || definition.isEmpty()) {
            errors += ToolError("INVALID_NEW_TYPE", "new_type 必须有 name 和 definition", "new_type")
        }
        library.findByName(name)?.let {
            errors += ToolError("TYPE_ALREADY_EXISTS", "类型库已有「$name」，请直接使用 type_id=${it.id.value}", "new_type.name")
        }
        val hardness = when (p.hardness?.trim()?.lowercase()) {
            "hard" -> Hardness.HARD
            "medium" -> Hardness.MEDIUM
            "soft" -> Hardness.SOFT
            else -> null.also { errors += ToolError("INVALID_HARDNESS", "new_type.hardness 只能是 hard / medium / soft", "new_type.hardness") }
        }
        val direction = if (p.directed == true) {
            val s = p.sourceRole?.trim().orEmpty()
            val t = p.targetRole?.trim().orEmpty()
            if (s.isEmpty() || t.isEmpty()) {
                errors += ToolError("MISSING_ROLES", "有向新类型必须给出 source_role 与 target_role", "new_type")
                return null
            }
            Direction.Directed(s, t)
        } else {
            Direction.Undirected
        }
        if (errors.size > before || hardness == null) return null
        return ResolvedType(TypeReference.Proposed(TypeProposal(name, definition, hardness, direction)), hardness, direction)
    }

    /** 解析首次判断：verdict 合法；undetermined 必须给原因；依据必填。 */
    private fun resolveVerdict(item: RelationInput, errors: MutableList<ToolError>): SemanticVerdict? {
        if (item.assessmentBasis.isNullOrBlank()) {
            errors += ToolError("MISSING_ASSESSMENT_BASIS", "assessment_basis 必须说明首次判断的依据", "assessment_basis")
        }
        return when (item.verdict?.trim()?.lowercase()) {
            "supported" -> SemanticVerdict.Supported
            "refuted" -> SemanticVerdict.Refuted
            "undetermined" -> {
                val reason = UndeterminedReason.entries.firstOrNull { it.name.equals(item.undeterminedReason?.trim(), ignoreCase = true) }
                if (reason == null) {
                    errors += ToolError("INVALID_UNDETERMINED_REASON", "verdict=undetermined 时 undetermined_reason 必须是 ${UndeterminedReason.entries.map { it.name.lowercase() }}", "undetermined_reason")
                    null
                } else {
                    SemanticVerdict.Undetermined(reason)
                }
            }
            else -> null.also { errors += ToolError("INVALID_VERDICT", "verdict 只能是 supported / undetermined / refuted", "verdict") }
        }
    }

    // ───────────────────────── 依据与引文 ─────────────────────────

    /** 解析一组依据：至少一项，每项有说明，引文若提供必须能在本章定位。 */
    private fun resolveEvidence(items: List<EvidenceInput>?, errors: MutableList<ToolError>): List<EvidenceRef> {
        if (items.isNullOrEmpty()) {
            errors += ToolError("MISSING_EVIDENCE", "evidence 至少一项（note 必填，quote 可选）", "evidence")
            return emptyList()
        }
        return items.mapIndexedNotNull { i, e -> evidenceOne(e.note, e.quote, e.at, "evidence[$i]", errors) }
    }

    /** 构造单项依据；说明为空或引文无效时记录错误并返回 null。 */
    private fun evidenceOne(note: String?, quote: String?, at: Int?, field: String, errors: MutableList<ToolError>): EvidenceRef? {
        val before = errors.size
        if (note.isNullOrBlank()) errors += ToolError("MISSING_NOTE", "$field.note 必须用一句话说明依据", "$field.note")
        val span = locateQuote(quote, at, "$field.quote", errors)
        if (errors.size > before) return null
        return EvidenceRef(EvidenceId("${chapter.id.value}-e${++evidenceSeq}"), chapter.id, note!!.trim(), listOfNotNull(span))
    }

    /**
     * 用 Chapter.locate 核实引文。
     *
     * 没给引文返回 null（基础证据模式允许）；找不到报错；同一句出现多次时按 [at] 选定，选不出来就把各处位置交还模型。
     */
    private fun locateQuote(raw: String?, at: Int?, field: String, errors: MutableList<ToolError>): TextSpan? {
        val quote = raw?.trim().orEmpty()
        if (quote.isEmpty()) return null
        return when (val found = chapter.locate(quote, at)) {
            is ExcerptLookup.Found -> found.span
            ExcerptLookup.NotFound -> null.also {
                errors += ToolError("QUOTE_NOT_FOUND", "引文未在本章正文中逐字匹配；请用 search_chapter 找到原句后原样复制，或省略 quote 只写 note", field)
            }
            is ExcerptLookup.Ambiguous ->
                found.occurrences.firstOrNull { at != null && at in it.start..it.end } ?: null.also {
                    val spots = found.occurrences.take(MAX_AMBIGUOUS_SHOWN).joinToString("；") { "at=${it.start}（${contextOf(it)}）" }
                    errors += ToolError("QUOTE_AMBIGUOUS", "引文在正文中出现 ${found.occurrences.size} 次，请用 at 指定起始位置，可选：$spots", field)
                }
        }
    }

    /** 命中位置前后各取一小段作上下文，帮助模型选择。 */
    private fun contextOf(span: TextSpan): String {
        val from = maxOf(0, span.start - AMBIGUOUS_CONTEXT)
        val to = minOf(chapter.text.length, span.end + AMBIGUOUS_CONTEXT)
        return chapter.text.substring(from, to).replace('\n', ' ')
    }

    // ───────────────────────── 交流观察 ─────────────────────────

    /**
     * 批量提交交流观察；每条独立校验。已提交硬 / 中关系的人物对会被跳过，不再记交流。
     */
    fun submitInteractions(items: List<InteractionInput>): Map<String, Any?> {
        val results = items.mapIndexed { index, item -> interactionOne(index, item) }
        return mapOf("status" to overallStatus(results), "results" to results)
    }

    /** 校验并记录单条交流观察；说明缺省时沿用交流描述。 */
    private fun interactionOne(index: Int, item: InteractionInput): Map<String, Any?> {
        val errors = mutableListOf<ToolError>()
        val a = localRef(item.personA, "person_a", errors)
        val b = localRef(item.personB, "person_b", errors)
        if (a != null && a == b) errors += ToolError("SELF_INTERACTION", "person_a 与 person_b 不能是同一人物", "person_b")
        val description = item.description?.trim().orEmpty()
        if (description.isEmpty()) errors += ToolError("MISSING_DESCRIPTION", "description 必须描述发生了什么交流", "description")
        val evidence = evidenceOne(item.note?.takeIf { it.isNotBlank() } ?: description.ifEmpty { null }, item.quote, item.at, "evidence", errors)
        if (errors.isNotEmpty() || a == null || b == null || evidence == null) return rejected(index, errors)
        if (setOf(a.key, b.key) in strongPairs) {
            return mapOf("index" to index, "status" to "skipped", "reason" to ToolError("STRONG_RELATION_EXISTS", "该人物对已提交硬 / 中关系，无需记交流").toMap())
        }
        val duplicate = interactions.any { it.participants == setOf(a, b) && it.description == description }
        if (duplicate) return mapOf("index" to index, "status" to "skipped", "reason" to ToolError("DUPLICATE", "已提交过相同的交流观察").toMap())
        interactions += InteractionObservation(InteractionId("${chapter.id.value}-i${interactions.size + 1}"), setOf(a, b), description, evidence)
        return mapOf("index" to index, "status" to "accepted")
    }

    // ───────────────────────── 提交与产出 ─────────────────────────

    /**
     * 提交本章结果。
     *
     * 新登记且参与关系候选的人物缺简介时一次性列全并退回（最多 [MAX_PROFILE_REJECTS] 次，之后接受并记入警告）；
     * 长章尚有未读正文时第一次被退回并列出未读区间；模型坚持再次提交则接受并记入警告。
     */
    fun submit(summaryText: String?): Map<String, Any?> {
        val text = summaryText?.trim().orEmpty()
        if (text.isEmpty()) return failure(ToolError("MISSING_SUMMARY", "summary 不能为空，用 1~3 句话概括本章", "summary"))
        val missing = missingProfiles()
        if (missing.isNotEmpty() && profileRejects < MAX_PROFILE_REJECTS) {
            profileRejects++
            return mapOf("status" to "error", "errors" to missing.map { it.toMap() })
        }
        if (missing.isNotEmpty()) warnings += "部分关系人物缺本章简介：${missing.joinToString("、") { it.field.orEmpty() }}"
        val gaps = unreadRanges()
        if (gaps.isNotEmpty() && !unreadWarned) {
            unreadWarned = true
            val ranges = gaps.take(MAX_GAPS_SHOWN).joinToString("、") { "[${it.first}, ${it.last + 1})" }
            return failure(ToolError("UNREAD_TEXT", "本章还有未读正文 $ranges；请用 read_chapter 读完后再提交（若确认无需阅读可再次提交）"))
        }
        if (gaps.isNotEmpty()) warnings += "正文未完整读取，建议重跑本章"
        summary = text
        submitted = true
        return mapOf("status" to "submitted", "persons" to locals.size, "relations" to candidates.size, "interactions" to interactions.size)
    }

    /** 新登记（未绑定名册人物）且作为任一关系候选端点的局部人物，若简介为空则各生成一条 PROFILE_REQUIRED 错误。 */
    private fun missingProfiles(): List<ToolError> {
        val endpoints = candidates.flatMapTo(linkedSetOf()) { listOf(it.source.key, it.target.key) }
        return locals.values
            .filter { it.ref.key in endpoints && it.existing == null && it.profile.isNullOrBlank() }
            .map {
                ToolError(
                    "PROFILE_REQUIRED",
                    "新登记人物 local_id=${it.ref.key}（${it.mentions.firstOrNull()?.name ?: "未命名"}）参与了关系候选，必须有本章简介；" +
                        "请用 register_persons(local_id=${it.ref.key}, profile=...) 补写一句 20~60 字的简介后再提交",
                    "${it.ref.key}.profile",
                )
            }
    }

    /** 未调用 submit_result 时由程序收尾：用 [fallbackSummary] 作摘要，并记入警告。 */
    fun finalizeWithoutSubmit(fallbackSummary: String) {
        warnings += "模型未调用 submit_result，已由程序收尾，建议重跑本章"
        if (unreadRanges().isNotEmpty()) warnings += "正文未完整读取，建议重跑本章"
        summary = fallbackSummary.trim().ifEmpty { "（模型未提交本章摘要）" }
        submitted = true
    }

    /**
     * 汇成领域对象。必须已提交（或已收尾）。
     *
     * 入参：[model] 所用模型名；[promptVersion] 提示词版本。
     */
    fun build(model: String, promptVersion: String): ChapterExtraction {
        check(submitted) { "本章尚未提交" }
        return ChapterExtraction(
            id = ExtractionId(UUID.randomUUID().toString()),
            chapterId = chapter.id,
            provenance = ExtractionProvenance(chapter.revision, model, promptVersion),
            mentions = locals.values.flatMap { it.mentions },
            claims = locals.values.map { it.claim() },
            candidates = candidates.toList(),
            firstAssessments = assessments.toList(),
            interactions = interactions.toList(),
            summary = ChapterSummary(summary),
        )
    }

    // ───────────────────────── 结果拼装 ─────────────────────────

    /** 单条被拒绝的结果。 */
    private fun rejected(index: Int, errors: List<ToolError>): Map<String, Any?> =
        mapOf("index" to index, "status" to "rejected", "errors" to errors.map { it.toMap() })

    /** 整批状态：全部通过 ok，全部被拒 error，其余 partial。 */
    private fun overallStatus(results: List<Map<String, Any?>>): String = when {
        results.all { it["status"] != "rejected" } -> "ok"
        results.all { it["status"] == "rejected" } -> "error"
        else -> "partial"
    }

    /** 整个调用级别的失败。 */
    private fun failure(error: ToolError): Map<String, Any?> = mapOf("status" to "error", "errors" to listOf(error.toMap()))

    private companion object {
        const val MAX_MATCHES = 50
        const val SNIPPET_RADIUS = 80
        const val ROSTER_LIST_LIMIT = 200
        const val MAX_AMBIGUOUS_SHOWN = 5
        const val AMBIGUOUS_CONTEXT = 12
        const val MAX_GAPS_SHOWN = 5

        /** 缺简介时最多退回提交的次数，之后接受并记入警告，避免工具循环卡死。 */
        const val MAX_PROFILE_REJECTS = 2

        /** 工具里的名称种类到领域名称种类；context_only 为 null，表示不进入全书绑定。 */
        val NAME_KINDS: Map<String?, NameKind?> = mapOf(
            "formal" to NameKind.FORMAL,
            "alias" to NameKind.ALIAS,
            "stable_appellation" to NameKind.STABLE_APPELLATION,
            "context_only" to null,
        )
    }
}
