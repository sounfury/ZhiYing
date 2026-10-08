import { useCallback, useEffect, useState } from 'react'
import { listBooks, type BookMeta } from '../api'

/**
 * 书籍列表管理。
 * 挂载时自动加载；refreshBooks 供手动刷新（分析完成、删除后调用）。
 * booksLoaded 表示至少成功加载过一次，用来区分「还没加载」和「书架确实为空」。
 */
export function useBooks() {
  const [books, setBooks] = useState<BookMeta[]>([])
  const [booksLoaded, setBooksLoaded] = useState(false)

  const refreshBooks = useCallback(async (): Promise<BookMeta[]> => {
    const list = await listBooks()
    setBooks(list)
    setBooksLoaded(true)
    return list
  }, [])

  useEffect(() => {
    void refreshBooks().catch(() => {
      /* 应用层可额外 toast；此处不阻塞 */
    })
  }, [refreshBooks])

  return { books, booksLoaded, refreshBooks }
}