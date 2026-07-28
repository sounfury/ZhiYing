import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { analysisChapters, listChapters, type ChapterBrief } from '../api'

/**
 * 章节列表 + 章节标题查找。
 *
 * - bookId 变化时自动加载
 * - onLoaded 在加载完成后回调（用于 App.tsx 重置 filter 等）
 * - chapterLabel 稳定引用，供其他 hook / 组件使用
 */
export function useChapters(
  bookId: string,
  onLoaded?: (chapters: ChapterBrief[]) => void,
) {
  const [chapters, setChapters] = useState<ChapterBrief[]>([])
  const chaptersRef = useRef<ChapterBrief[]>([])

  // 用 ref 持有 onLoaded 避免其变化触发重新加载
  const onLoadedRef = useRef(onLoaded)
  onLoadedRef.current = onLoaded

  const chapterLabel = useCallback((chapterId: number | undefined) => {
    if (chapterId == null) return '?'
    const hit = chaptersRef.current.find((c) => c.chapter_id === chapterId)
    if (hit?.title) return hit.title
    return `第 ${chapterId} 段`
  }, [])

  const contentChapters = useMemo(() => analysisChapters(chapters), [chapters])

  useEffect(() => {
    if (!bookId) {
      setChapters([])
      chaptersRef.current = []
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const list = await listChapters(bookId)
        if (cancelled) return
        setChapters(list)
        chaptersRef.current = list
        onLoadedRef.current?.(list)
      } catch {
        if (!cancelled) {
          setChapters([])
          chaptersRef.current = []
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [bookId])

  return { chapters, contentChapters, chapterLabel }
}