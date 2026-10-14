// 分析方法摘要按任务或当前生效模型快照计算，由基础设施提供提示版本。
package com.zhiying.application.analyze.run

import com.zhiying.application.llm.ModelSnapshot

fun interface AnalysisMethod {
    fun version(models: ModelSnapshot): String
}
