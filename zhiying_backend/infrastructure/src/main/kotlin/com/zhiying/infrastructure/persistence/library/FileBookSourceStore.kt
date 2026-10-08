// 书籍源文件存储：把导入的 EPUB 按内容摘要保存到 booksDir，相同内容只存一份。
package com.zhiying.infrastructure.persistence.library

import com.zhiying.application.library.BookSourceStore
import com.zhiying.domain.library.SourceFileRef
import com.zhiying.infrastructure.config.ZhiYingProperties
import org.springframework.stereotype.Component
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.MessageDigest

/** 文件系统实现的源文件存储。 */
@Component
class FileBookSourceStore(properties: ZhiYingProperties) : BookSourceStore {
    private val dir = properties.storage.booksDir

    /**
     * 保存源文件，文件名为 `<SHA-256>.epub`；先写临时文件再改名，避免留下写了一半的文件。
     * 入参：[content] 文件字节。出参：以摘要为值的源文件引用。
     */
    override fun save(content: ByteArray): SourceFileRef {
        val digest = MessageDigest.getInstance("SHA-256").digest(content).joinToString("") { "%02x".format(it) }
        val target = dir.resolve("$digest.epub")
        if (!Files.exists(target)) {
            Files.createDirectories(dir)
            val temp = Files.createTempFile(dir, "upload-", ".tmp")
            Files.write(temp, content)
            Files.move(temp, target, StandardCopyOption.REPLACE_EXISTING)
        }
        return SourceFileRef(digest)
    }

    /** 删除 `<摘要>.epub`；文件不存在时什么也不做。 */
    override fun delete(ref: SourceFileRef) {
        Files.deleteIfExists(dir.resolve("${ref.value}.epub"))
    }
}
