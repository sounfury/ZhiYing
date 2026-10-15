// 通用后台设置的持久化端口；值保留 JSON，支持模型专用设置共享复合键存储。
package com.zhiying.application.settings

import com.zhiying.application.llm.PromptSnapshot

interface AppSettings {
    fun get(
        group: String,
        key: String,
    ): String?

    fun list(group: String): Map<String, String>

    /** 提示文本与参数在同一快照内定版，进行中的任务不再读取设置。 */
    fun promptSnapshot(): PromptSnapshot

    fun put(
        group: String,
        key: String,
        valueJson: String,
        userId: String,
    )

    fun delete(
        group: String,
        key: String,
    )
}
