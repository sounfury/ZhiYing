// 反馈用例：确认登录与书籍读权限，保存快照；管理员只读反馈，示例书可定位当前对象。
package com.zhiying.application.feedback

import com.zhiying.application.account.Accounts
import com.zhiying.application.error.AppException
import com.zhiying.application.error.ErrorCode
import com.zhiying.application.graphquery.RevisionStore
import com.zhiying.application.library.BookAccess
import com.zhiying.application.library.ExampleBooks
import com.zhiying.application.library.ShelfItems
import com.zhiying.domain.account.Account
import com.zhiying.domain.feedback.Feedback
import com.zhiying.domain.feedback.FeedbackCategory
import com.zhiying.domain.feedback.FeedbackTarget
import com.zhiying.domain.library.BookId
import com.zhiying.domain.revision.RevisionId
import org.springframework.stereotype.Service
import java.time.Instant
import java.util.UUID

interface FeedbackStore {
    fun save(feedback: Feedback)

    fun list(itemId: String?): List<Feedback>
}

data class FeedbackInput(
    val targetKind: FeedbackTarget = FeedbackTarget.GENERAL,
    val targetRef: String? = null,
    val targetLabel: String? = null,
    val revisionId: String? = null,
    val scope: String? = null,
    val category: FeedbackCategory? = null,
    val note: String? = null,
)

data class AdminFeedback(
    val feedback: Feedback,
    val exampleSlug: String?,
    val targetExists: Boolean,
)

@Service
class Feedbacks(
    private val accounts: Accounts,
    private val access: BookAccess,
    private val items: ShelfItems,
    private val examples: ExampleBooks,
    private val revisions: RevisionStore,
    private val store: FeedbackStore,
) {
    fun submit(
        user: Account?,
        itemId: BookId?,
        input: FeedbackInput,
    ) {
        val account = accounts.requireUser(user)
        if ((itemId == null) != (input.targetKind == FeedbackTarget.GENERAL)) {
            throw AppException(ErrorCode.INVALID_ARGUMENT, "请通过对应的反馈入口提交")
        }
        if (itemId != null) access.requireRead(account, itemId)
        val book = itemId?.let(items::overview)
        val feedback =
            try {
                Feedback(
                    UUID.randomUUID().toString(),
                    Instant.now(),
                    account.id,
                    itemId?.value,
                    book?.book?.id?.value,
                    book?.book?.title,
                    input.revisionId,
                    input.targetKind,
                    input.targetRef,
                    input.targetLabel,
                    input.category,
                    input.note?.trim()?.takeIf(String::isNotEmpty),
                    input.scope,
                )
            } catch (e: IllegalArgumentException) {
                throw AppException(ErrorCode.INVALID_ARGUMENT, e.message ?: "反馈参数不合法")
            }
        feedback.revisionId?.let { revisionId ->
            val revision = revisions.find(RevisionId(revisionId))
            if (revision == null || revision.bookId.value != feedback.bookId) {
                throw AppException(ErrorCode.INVALID_ARGUMENT, "结果版本已变更，请刷新后再反馈")
            }
        }
        store.save(feedback)
    }

    fun list(
        user: Account,
        book: String?,
    ): List<AdminFeedback> {
        accounts.requireAdministrator(user)
        return store.list(book).map { feedback ->
            val itemId = feedback.itemId?.let(::BookId)
            val slug = itemId?.takeIf(examples::isPublished)?.let(examples::slug)
            val current = if (slug != null) revisions.findPublished(items.resultBookId(itemId)) else null
            val exists =
                when (feedback.targetKind) {
                    FeedbackTarget.PERSON -> {
                        current?.persons?.any { it.id.value == feedback.targetRef } == true
                    }

                    FeedbackTarget.RELATION -> {
                        current?.facts()?.any {
                            "${it.key.first.value}/${it.key.second.value}/${it.key.type.value}" == feedback.targetRef
                        } == true
                    }

                    else -> {
                        false
                    }
                }
            AdminFeedback(feedback, slug, exists)
        }
    }
}
