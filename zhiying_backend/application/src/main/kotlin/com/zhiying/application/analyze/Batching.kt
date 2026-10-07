// 有界分批：模型调用统一按"条数 + 输入长度"双上限分批，各步骤共用。
package com.zhiying.application.analyze

/** 单次模型请求的批量上限：最多条数与近似输入字符数。 */
data class BatchLimits(val maxItems: Int, val maxChars: Int) {
    init {
        require(maxItems >= 1 && maxChars >= 1) { "批量上限必须为正" }
    }
}

/**
 * 按条数与近似字符数上限把 [items] 切成连续的批次，保持原顺序。
 * 单项超过字符上限时独占一批，不丢弃。[sizeOf] 给出单项的近似输入长度。
 */
internal fun <T> boundedBatches(items: List<T>, limits: BatchLimits, sizeOf: (T) -> Int): List<List<T>> {
    val batches = mutableListOf<MutableList<T>>()
    var chars = 0
    for (item in items) {
        val size = sizeOf(item)
        val current = batches.lastOrNull()
        val fits = current != null && current.size < limits.maxItems && chars + size <= limits.maxChars
        if (fits) {
            current!!.add(item)
            chars += size
        } else {
            batches.add(mutableListOf(item))
            chars = size
        }
    }
    return batches
}
