// 书籍访问用例：私人书按上传者隔离，已发布示例公开读取，示例维护仅限管理员。
package com.zhiying.application.library

import com.zhiying.application.account.Accounts
import com.zhiying.application.error.AppException
import com.zhiying.application.error.ErrorCode
import com.zhiying.domain.account.Account
import com.zhiying.domain.library.BookId
import org.springframework.stereotype.Service

@Service
class BookAccess(
    private val books: BookRepository,
    private val examples: ExampleBooks,
    private val accounts: Accounts,
    private val items: ShelfItems,
) {
    fun list(user: Account?): List<BookOverview> {
        val own = user?.let { books.listBooks(it.id) }.orEmpty()
        val published = examples.ids().filter(examples::isPublished).map(items::overview)
        return (own + published).distinctBy { it.itemId }.sortedByDescending { it.importedAt }
    }

    fun requireOwner(
        user: Account?,
        id: BookId,
    ) {
        val account = accounts.requireUser(user)
        if (items.get(id).userId != account.id) throw AppException(ErrorCode.NOT_FOUND)
    }

    fun requireRead(user: Account?, id: BookId) {
        if (!examples.isPublished(id)) {
            if (examples.slug(id) != null) accounts.requireAdministrator(user)
            requireOwner(user, id)
        }
    }

    fun requireWrite(
        user: Account?,
        id: BookId,
    ) {
        if (examples.slug(id) != null) {
            accounts.requireAdministrator(user)
        } else {
            requireOwner(user, id)
        }
    }
}
