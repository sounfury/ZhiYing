package com.zhiying.domain.identity

/**
 * 全书统一的身份映射：局部人物引用 → 书内人物，以及人物合并（被并入者 → 保留者）。
 *
 * 所有关系端点、团体成员都经由同一份映射解析；合并只登记映射，不靠全局替换 ID。
 * 合并后两端落到同一人物的关系会变成自环，由关系规则拒绝出图并重新处理。
 */
class IdentityMap private constructor(
    private val locals: Map<LocalPersonRef, PersonId>,
    private val mergedInto: Map<PersonId, PersonId>,
) {

    /** 把局部人物绑定到书内人物，返回新映射；同一局部人物不能绑定到两个不同的人。 */
    fun bind(local: LocalPersonRef, person: PersonId): IdentityMap {
        val current = locals[local]
        require(current == null || canonical(current) == canonical(person)) {
            "局部人物 ${local.key} 已绑定到 ${current?.value}"
        }
        return IdentityMap(locals + (local to person), mergedInto)
    }

    /**
     * 登记合并：[absorbed] 并入 [survivor]，返回新映射。
     * 双方先各自取当前身份再连接，因此合并链不会成环。
     */
    fun merge(absorbed: PersonId, survivor: PersonId): IdentityMap {
        val from = canonical(absorbed)
        val to = canonical(survivor)
        return if (from == to) this else IdentityMap(locals, mergedInto + (from to to))
    }

    /** 人物的当前身份：沿合并链找到最终保留者。 */
    fun canonical(person: PersonId): PersonId = generateSequence(person) { mergedInto[it] }.last()

    /** 解析局部人物引用到当前身份；尚未绑定时返回 null。 */
    fun resolve(local: LocalPersonRef): PersonId? = locals[local]?.let(::canonical)

    companion object {
        /** 空映射。 */
        val EMPTY = IdentityMap(emptyMap(), emptyMap())
    }
}
