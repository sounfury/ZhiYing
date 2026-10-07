package com.zhiying.domain.relations

/** 关系类型的稳定身份。 */
@JvmInline
value class RelationTypeId(val value: String) {
    init {
        require(value.isNotBlank()) { "关系类型 ID 不能为空" }
    }
}

/** 章内关系候选的身份。 */
@JvmInline
value class CandidateId(val value: String) {
    init {
        require(value.isNotBlank()) { "关系候选 ID 不能为空" }
    }
}

/** 交流观察的身份。 */
@JvmInline
value class InteractionId(val value: String) {
    init {
        require(value.isNotBlank()) { "交流观察 ID 不能为空" }
    }
}

/** 章账本中关系记录的稳定身份，在重跑中保持不变。 */
@JvmInline
value class OccurrenceId(val value: String) {
    init {
        require(value.isNotBlank()) { "关系记录 ID 不能为空" }
    }
}
