import { useCallback, useEffect, useState } from 'react'
import { getChapterLedger, type ChapterLedger } from '../api'

/**
 * 单章账本。chapterId 为空不请求；404 记为 missing（尚未分析），其它错误进 error。
 */
export function useLedger(bookId: string, chapterId: number | '') {
  const [ledger, setLedger] = useState<ChapterLedger | null>(null)
  const [loading, setLoading] = useState(false)
  const [missing, setMissing] = useState(false)
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    if (!bookId || chapterId === '') {
      setLedger(null)
      setMissing(false)
      setError('')
      return
    }
    setLoading(true)
    setError('')
    setMissing(false)
    try {
      setLedger(await getChapterLedger(bookId, chapterId))
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      setLedger(null)
      if (message.startsWith('404')) {
        setMissing(true)
        setError('')
      } else {
        setError(message)
      }
    } finally {
      setLoading(false)
    }
  }, [bookId, chapterId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return { ledger, loading, missing, error, refresh }
}
