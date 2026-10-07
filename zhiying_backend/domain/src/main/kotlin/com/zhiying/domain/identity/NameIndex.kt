package com.zhiying.domain.identity

/**
 * 名称索引：按名称查找候选人物。
 *
 * 名称只用于寻找候选，不证明同人：同名或共享称呼的不同人物会一起返回，
 * 由身份判断决定绑定到谁，绝不按首个命中自动合并。
 */
class NameIndex private constructor(private val candidatesByName: Map<String, Set<PersonId>>) {

    /** 返回使用该名称的全部人物；没有命中时为空集合。 */
    fun candidates(name: String): Set<PersonId> = candidatesByName[name.trim()].orEmpty()

    /**
     * 由共享名称连成的候选组：共享同一名称的人物互为候选，有传递关系的合成一组（连通分量）。
     * 只返回至少两人的组。注意候选组不等于合并组——组内谁是同一人仍需身份判断。
     */
    fun candidateGroups(): List<Set<PersonId>> {
        val parent = HashMap<PersonId, PersonId>()
        fun find(x: PersonId): PersonId = generateSequence(x) { parent[it]?.takeIf { p -> p != it } }.last()
        for (ids in candidatesByName.values.filter { it.size >= 2 }) {
            val root = find(ids.first())
            ids.forEach { id -> parent[find(id)] = root }
        }
        return parent.keys.groupBy(::find).values.filter { it.size >= 2 }
            .map { group -> group.sortedBy { it.value }.toCollection(linkedSetOf()) }
            .sortedBy { it.first().value }
    }

    companion object {
        /** 稳定称呼参与桥接时，共用该称呼的人物数上限默认值。 */
        const val DEFAULT_APPELLATION_BRIDGE_LIMIT = 4

        /**
         * 建立用于生成候选组的索引。正式名与别名直接桥接；稳定称呼（如「迪达勒斯太太」）只在共用它的人物
         * 不超过 [appellationLimit] 时桥接——长章分段、并行读章会把同一个无姓名人物登记多次，需要拿去判断；
         * 而「仆人」「老板娘」这类多人共用的泛称会把无关人物连成大组，不桥接。
         */
        fun bridging(persons: Iterable<Person>, appellationLimit: Int = DEFAULT_APPELLATION_BRIDGE_LIMIT): NameIndex {
            val (appellations, names) = persons
                .flatMap { person -> person.bindings.map { Triple(it.name, it.kind, person.id) } }
                .partition { it.second == NameKind.STABLE_APPELLATION }
            val narrow = appellations.groupBy { it.first }
                .filterValues { entries -> entries.mapTo(mutableSetOf()) { it.third }.size <= appellationLimit }
                .values.flatten()
            return NameIndex(
                (names + narrow).groupBy(keySelector = { it.first }, valueTransform = { it.third })
                    .mapValues { (_, ids) -> ids.toSet() },
            )
        }

        /** 由人物已成立的名称绑定建立索引。 */
        fun of(persons: Iterable<Person>): NameIndex = NameIndex(
            persons.flatMap { person -> person.names.map { name -> name to person.id } }
                .groupBy(keySelector = { it.first }, valueTransform = { it.second })
                .mapValues { (_, ids) -> ids.toSet() },
        )
    }
}
