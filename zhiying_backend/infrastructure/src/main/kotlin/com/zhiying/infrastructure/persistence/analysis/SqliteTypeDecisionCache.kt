// 类型语义决策缓存的 SQLite 实现：TypeDecision 序列化成 JSON，按 TypeSemanticKey.text 存取。
package com.zhiying.infrastructure.persistence.analysis

import com.zhiying.application.analyze.relations.TypeDecisionCache
import com.zhiying.domain.relations.Direction
import com.zhiying.domain.relations.Hardness
import com.zhiying.domain.relations.Orientation
import com.zhiying.domain.relations.RelationTypeId
import com.zhiying.domain.relations.TypeDecision
import com.zhiying.domain.relations.TypeSemanticKey
import org.slf4j.LoggerFactory
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.stereotype.Repository
import tools.jackson.module.kotlin.jacksonObjectMapper
import tools.jackson.module.kotlin.readValue

/** 缓存的存储记录；领域对象不带序列化注解，格式只在此处演进。 */
internal data class TypeDecisionRecord(
    val kind: String,
    val reason: String,
    val type: String? = null,
    val reverse: Boolean = false,
    val name: String? = null,
    val definition: String? = null,
    val hardness: String? = null,
    val directed: Boolean = false,
    val sourceRole: String? = null,
    val targetRole: String? = null,
    val synonyms: List<String> = emptyList(),
)

/**
 * [TypeDecisionCache] 的 SQLite 实现。
 *
 * 键含策略版本与类型库指纹，所以类型库或策略变化后旧行自然不再命中。"无法归一"的结论不缓存
 * （可能只是一次模型的拿不准，不应成为永久结论）；读取时解析失败按未命中处理，不让缓存损坏阻断分析。
 */
@Repository
class SqliteTypeDecisionCache(private val jdbc: JdbcClient) : TypeDecisionCache {
    private val mapper = jacksonObjectMapper()
    private val log = LoggerFactory.getLogger(SqliteTypeDecisionCache::class.java)

    /** 取已缓存的结论；未命中或记录无法解析时返回 null。 */
    override fun get(key: TypeSemanticKey): TypeDecision? {
        val payload = jdbc.sql("SELECT payload FROM type_decision_cache WHERE cache_key = ?")
            .param(key.text).query(String::class.java).optional().orElse(null) ?: return null
        return try {
            mapper.readValue<TypeDecisionRecord>(payload).toDomain()
        } catch (e: Exception) {
            log.warn("类型缓存记录无法解析，按未命中处理：{}", e.message)
            null
        }
    }

    /** 保存一次语义结论；同键覆盖。无法归一的结论不保存。 */
    override fun put(key: TypeSemanticKey, decision: TypeDecision) {
        if (decision is TypeDecision.Unresolved) return
        jdbc.sql(
            "INSERT INTO type_decision_cache (cache_key, payload) VALUES (?, ?) " +
                "ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload, " +
                "created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
        ).params(key.text, mapper.writeValueAsString(decision.toRecord())).update()
    }
}

/** 领域结论转存储记录。 */
private fun TypeDecision.toRecord(): TypeDecisionRecord = when (this) {
    is TypeDecision.UseExisting ->
        TypeDecisionRecord("existing", reason, type = type.value, reverse = orientation == Orientation.REVERSED)
    is TypeDecision.NewType -> TypeDecisionRecord(
        "new", reason, name = name, definition = definition, hardness = hardness.name,
        directed = direction is Direction.Directed,
        sourceRole = (direction as? Direction.Directed)?.sourceRole,
        targetRole = (direction as? Direction.Directed)?.targetRole,
        synonyms = synonyms.toList(),
    )
    is TypeDecision.Unresolved -> TypeDecisionRecord("unresolved", reason)
}

/** 存储记录转领域结论；字段缺失或种类未知时抛出，由读取方按未命中处理。 */
private fun TypeDecisionRecord.toDomain(): TypeDecision = when (kind) {
    "existing" -> TypeDecision.UseExisting(
        RelationTypeId(requireNotNull(type)), if (reverse) Orientation.REVERSED else Orientation.AS_OBSERVED, reason,
    )
    "new" -> TypeDecision.NewType(
        name = requireNotNull(name),
        definition = requireNotNull(definition),
        hardness = Hardness.valueOf(requireNotNull(hardness)),
        direction = if (directed) Direction.Directed(requireNotNull(sourceRole), requireNotNull(targetRole)) else Direction.Undirected,
        synonyms = synonyms.toSet(),
        reason = reason,
    )
    "unresolved" -> TypeDecision.Unresolved(reason)
    else -> throw IllegalArgumentException("未知的缓存结论种类: $kind")
}
