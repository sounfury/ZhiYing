// 管理员模型配置接口：只允许编辑模型名与思考开关，删除覆盖值恢复部署配置。
package com.zhiying.web.account

import com.zhiying.application.error.AppException
import com.zhiying.application.error.ErrorCode
import com.zhiying.application.llm.ModelCallPoint
import com.zhiying.application.llm.ModelSettings
import com.zhiying.domain.account.Account
import org.springframework.http.HttpStatus
import org.springframework.web.bind.annotation.*

@RestController
@RequestMapping("/api/admin/models")
class ModelSettingsController(
    private val settings: ModelSettings,
) {
    @GetMapping
    fun list(
        @RequestAttribute("user") user: Account,
    ) = settings.list(user)

    @PutMapping("/{callPoint}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun save(
        @RequestAttribute("user") user: Account,
        @PathVariable callPoint: String,
        @RequestBody body: ModelSettingRequest,
    ) {
        settings.save(user, pointOf(callPoint), body.model, body.thinking)
    }

    @DeleteMapping("/{callPoint}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun reset(
        @RequestAttribute("user") user: Account,
        @PathVariable callPoint: String,
    ) {
        settings.reset(user, pointOf(callPoint))
    }

    private fun pointOf(raw: String) =
        ModelCallPoint.entries.firstOrNull { it.name == raw }
            ?: throw AppException(ErrorCode.INVALID_ARGUMENT, "未知分析环节")
}

data class ModelSettingRequest(
    val model: String,
    val thinking: Boolean,
)
