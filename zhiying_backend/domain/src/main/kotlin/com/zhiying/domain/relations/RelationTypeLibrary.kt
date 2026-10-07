package com.zhiying.domain.relations

/**
 * 本书可用的关系类型库：内置类型 + 本书登记的新类型。
 *
 * 库内 ID 与名称（含同义名）都唯一，保证按名称的确定性匹配至多命中一个类型。
 */
class RelationTypeLibrary private constructor(private val typesById: Map<RelationTypeId, RelationType>) {

    /** 全部类型。 */
    val types: Collection<RelationType> get() = typesById.values

    /** 按 ID 取类型；未知 ID 返回 null。 */
    operator fun get(id: RelationTypeId): RelationType? = typesById[id]

    /** 按正式名或同义名精确匹配类型。这是类型归一的确定性快路径，未命中才需要模型判断。 */
    fun findByName(name: String): RelationType? = name.trim().let { key -> types.firstOrNull { key in it.names } }

    /**
     * 按名称匹配类型并给出端点对应关系：命中正式名 / 同义名时按观察顺序，命中反向称呼时需对调。
     * 比 [findByName] 多回答了方向问题，是类型归一的确定性快路径。
     */
    fun match(name: String): TypeMatch? {
        val key = name.trim()
        val type = types.firstOrNull { key in it.allNames } ?: return null
        return TypeMatch(type, if (key in type.names) Orientation.AS_OBSERVED else Orientation.REVERSED)
    }

    /**
     * 类型库指纹：类型集合的内容摘要。类型语义缓存以它作为键的一部分，类型库变化后旧缓存自然失效。
     */
    val fingerprint: String
        get() {
            val canonical = types.sortedBy { it.id.value }.joinToString(separator = ";") {
                listOf(it.id.value, it.hardness, it.direction, it.definition, it.allNames.sorted()).joinToString("|")
            }
            val digest = java.security.MessageDigest.getInstance("SHA-256").digest(canonical.toByteArray())
            return digest.joinToString("") { "%02x".format(it) }
        }

    /** 登记一个本书新类型，返回新的类型库；ID 或任一名称与已有类型冲突时报错。 */
    fun register(type: RelationType): RelationTypeLibrary {
        require(type.origin == TypeOrigin.BOOK) { "只能登记本书新类型" }
        return of(types + type)
    }

    companion object {
        /** 由一组类型建立类型库，校验 ID 与名称唯一。 */
        fun of(types: Collection<RelationType>): RelationTypeLibrary {
            requireUnique(types.map { it.id.value }, "类型 ID")
            requireUnique(types.flatMap { it.allNames }, "类型名称")
            return RelationTypeLibrary(types.associateBy { it.id })
        }
    }
}

/** 名称匹配结果：命中的类型，以及观察顺序与类型规范方向的对应关系。 */
data class TypeMatch(val type: RelationType, val orientation: Orientation)

/** 校验值不重复，重复时在错误信息中列出重复项。 */
private fun requireUnique(values: List<String>, what: String) {
    val duplicates = values.groupingBy { it }.eachCount().filterValues { it > 1 }.keys
    require(duplicates.isEmpty()) { "$what 重复: $duplicates" }
}
