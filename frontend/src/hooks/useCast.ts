/** 人名册（只读）：随 bookId 加载，分析完成或重跑后由调用方 refresh。本期不提供人工改名 / 合并（PRD §5.8）。 */
import { useCallback, useEffect, useState } from 'react'
import { getCast, type Cast } from '../api'

export function useCast(bookId: string) {
  const [cast, setCast] = useState<Cast | null>(null)
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async () => {
    if (!bookId) {
      setCast(null)
      return
    }
    setLoading(true)
    try {
      setCast(await getCast(bookId))
    } catch {
      setCast(null)
    } finally {
      setLoading(false)
    }
  }, [bookId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return { cast, loading, refresh }
}
