// 分析方法摘要按任务或当前生效的模型与提示快照计算。
package com.zhiying.application.analyze.run

import com.zhiying.application.llm.ModelSnapshot
import com.zhiying.application.llm.PromptSnapshot

fun interface AnalysisMethod {
    fun version(
        models: ModelSnapshot,
        prompts: PromptSnapshot,
    ): String
}
