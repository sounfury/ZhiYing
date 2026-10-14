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
) {
    fun list(user: Account?): List<BookOverview> {
        val own = user?.let { books.listBooks(it.id) }.orEmpty()
        val published = examples.ids().filter(examples::isPublished).mapNotNull(books::findBook)
        return (own + published).distinctBy { it.book.id }.sortedByDescending { it.importedAt }
    }

    fun requireOwner(
        user: Account?,
        id: BookId,
    ) {
        val account = accounts.requireUser(user)
        if (books.ownerId(id) != account.id) throw AppException(ErrorCode.NOT_FOUND)
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
