// 用户反馈：保存提交时的对象与书名快照，校验输入，不改变分析结果。
package com.zhiying.domain.feedback

import java.time.Instant

enum class FeedbackTarget { PERSON, RELATION, GROUP, GENERAL }

enum class FeedbackCategory { DUPLICATE_PERSON, WRONG_RELATION, WRONG_GROUP, MISSING, OTHER }

data class Feedback(
    val id: String,
    val createdAt: Instant,
    val userId: String,
    val itemId: String?,
    val bookId: String?,
    val bookTitle: String?,
    val revisionId: String?,
    val targetKind: FeedbackTarget,
    val targetRef: String?,
    val targetLabel: String?,
    val category: FeedbackCategory?,
    val note: String?,
    val scope: String?,
) {
    init {
        require(id.isNotBlank() && userId.isNotBlank()) { "反馈与提交者 ID 不能为空" }
        require(note == null || note.codePointCount(0, note.length) <= 200) { "说明不能超过 200 字" }
        if (targetKind == FeedbackTarget.GENERAL) {
            require(listOf(itemId, bookId, bookTitle, revisionId, targetRef, targetLabel, scope).all { it == null }) { "通用反馈不能附带书籍对象" }
        } else {
            require(
                listOf(itemId, bookId, bookTitle, revisionId, targetRef, targetLabel, scope).all { !it.isNullOrBlank() },
            ) { "对象反馈必须附带书、对象、版本与范围" }
            require(targetRef!!.length <= 500 && targetLabel!!.length <= 500) { "对象标识或名称过长" }
            require(scope == "all" || scope!!.matches(Regex("(?:single|upto):[1-9][0-9]{0,8}"))) { "分析范围不合法" }
            if (targetKind == FeedbackTarget.RELATION) {
                require(targetRef.split('/').let { it.size == 3 && it.all(String::isNotBlank) }) { "关系标识须包含两端人物与类型" }
            }
        }
    }
}
