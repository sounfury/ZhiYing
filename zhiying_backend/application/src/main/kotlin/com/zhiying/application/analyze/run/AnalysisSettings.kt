// 整书分析编排的可调参数（由基础设施从 zhiying.analysis.* 与 zhiying.reading.* 装配，应用层不依赖配置类）。
package com.zhiying.application.analyze.run

/**
 * 入参：[concurrency] 同时在读的阅读单元数；[unitMaxChars] 阅读单元字数上限（超过的章均分切段）；
 * [maxRequests]、[maxTokens] 整个任务的模型请求数与 token 预算，0 表示不限。
 */
data class AnalysisSettings(
    val concurrency: Int,
    val unitMaxChars: Int,
    val maxRequests: Long = 0,
    val maxTokens: Long = 0,
) {
    init {
        require(concurrency >= 1) { "并发数至少为 1" }
        require(unitMaxChars >= 1) { "阅读单元字数上限必须为正" }
    }
}
