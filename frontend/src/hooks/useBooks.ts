import { useCallback, useEffect, useState } from 'react'
import { listBooks, type BookMeta } from '../api'

/**
 * 书籍列表管理。
 * 挂载时自动加载；refreshBooks 供手动刷新（分析完成后调用）。
 */
export function useBooks() {
  const [books, setBooks] = useState<BookMeta[]>([])

  const refreshBooks = useCallback(async (): Promise<BookMeta[]> => {
    const list = await listBooks()
    setBooks(list)
    return list
  }, [])

  useEffect(() => {
    void refreshBooks().catch(() => {
      /* 应用层可额外 toast；此处不阻塞 */
    })
  }, [refreshBooks])

  return { books, refreshBooks }
}