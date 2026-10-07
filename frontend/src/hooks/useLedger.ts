/**
 * 章节分析结果（账本）的读取：
 * - useLedger：单章（章节聚焦时人物卡用），chapterId 为空不请求；404 记为 missing。
 * - useChapterLedgers：章节页签的按需缓存，卡片进入可视区或展开时才取，最多两路并发，书或结果变化时整体失效。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { getChapterLedger, type ChapterLedger } from '../api'

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

export type LedgerEntry =
  | { status: 'loading' }
  | { status: 'ok'; ledger: ChapterLedger }
  | { status: 'missing' }
  | { status: 'error'; error: string }

const MAX_CONCURRENT = 2

export function useChapterLedgers(bookId: string) {
  const [entries, setEntries] = useState<Record<number, LedgerEntry>>({})
  // 已排队或已取过的章节；与 generation 一起保证失效后的旧请求不回写
  const known = useRef(new Set<number>())
  const queue = useRef<number[]>([])
  const active = useRef(0)
  const generation = useRef(0)
  const bookRef = useRef(bookId)

  const invalidate = useCallback(() => {
    generation.current += 1
    known.current = new Set()
    queue.current = []
    active.current = 0
    setEntries({})
  }, [])

  useEffect(() => {
    bookRef.current = bookId
    invalidate()
  }, [bookId, invalidate])

  const pump = useCallback(() => {
    while (active.current < MAX_CONCURRENT && queue.current.length) {
      const chapterId = queue.current.shift()!
      const gen = generation.current
      const book = bookRef.current
      active.current += 1
      getChapterLedger(book, chapterId)
        .then((ledger): LedgerEntry => ({ status: 'ok', ledger }))
        .catch((e): LedgerEntry => {
          const message = e instanceof Error ? e.message : String(e)
          return message.startsWith('404') ? { status: 'missing' } : { status: 'error', error: message }
        })
        .then((entry) => {
          if (gen !== generation.current) return
          setEntries((prev) => ({ ...prev, [chapterId]: entry }))
          active.current -= 1
          pump()
        })
    }
  }, [])

  /** 请求某章结果；已取过或在排队的忽略 */
  const request = useCallback(
    (chapterId: number) => {
      if (!bookRef.current || known.current.has(chapterId)) return
      known.current.add(chapterId)
      queue.current.push(chapterId)
      setEntries((prev) => ({ ...prev, [chapterId]: { status: 'loading' } }))
      pump()
    },
    [pump],
  )

  return { entries, request, invalidate }
}
