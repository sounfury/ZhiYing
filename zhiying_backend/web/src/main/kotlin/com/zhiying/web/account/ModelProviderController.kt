// 管理员模型服务商接口：列出、新增、修改、删除 OpenAI 兼容服务商，并实时拉取其模型列表；响应不含密钥明文。
package com.zhiying.web.account

import com.zhiying.application.llm.ModelProviders
import com.zhiying.application.llm.ProviderDraft
import com.zhiying.application.llm.ThinkingStyle
import com.zhiying.domain.account.Account
import org.springframework.http.HttpStatus
import org.springframework.web.bind.annotation.*

@RestController
@RequestMapping("/api/admin/model-providers")
class ModelProviderController(
    private val providers: ModelProviders,
) {
    @GetMapping
    fun list(
        @RequestAttribute("user") user: Account,
    ) = providers.list(user)

    @PostMapping
    fun create(
        @RequestAttribute("user") user: Account,
        @RequestBody body: ProviderRequest,
    ) = mapOf("id" to providers.create(user, body.draft()))

    @PutMapping("/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun update(
        @RequestAttribute("user") user: Account,
        @PathVariable id: String,
        @RequestBody body: ProviderRequest,
    ) {
        providers.update(user, id, body.draft())
    }

    @DeleteMapping("/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun delete(
        @RequestAttribute("user") user: Account,
        @PathVariable id: String,
    ) {
        providers.delete(user, id)
    }

    @GetMapping("/{id}/models")
    fun models(
        @RequestAttribute("user") user: Account,
        @PathVariable id: String,
    ) = providers.models(user, id)
}

/** [apiKey] 留空表示修改时保留原密钥。 */
data class ProviderRequest(
    val name: String,
    val baseUrl: String,
    val apiKey: String = "",
    val thinkingStyle: ThinkingStyle = ThinkingStyle.NONE,
) {
    fun draft() = ProviderDraft(name, baseUrl, apiKey, thinkingStyle)
}
