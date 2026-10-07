import { useCallback, useEffect, useRef, useState } from 'react'
import { getGraph, type GraphData } from '../api'
import type { GraphFilters } from '../types'

/**
 * 图谱数据加载。
 *
 * - loadGraph 只管数据 state（graph / graphLoading）
 * - 返回 { error, msg } 供 App.tsx 设置 banner
 * - 不自动触发；由 App.tsx 用 useEffect 串联 bookId / filter 变化
 */
export function useGraphData(
  bookId: string,
  filters: GraphFilters,
  chapterLabel: (id: number | undefined) => string,
) {
  const [graph, setGraph] = useState<GraphData | null>(null)
  const [graphLoading, setGraphLoading] = useState(false)
  const requestSeq = useRef(0)

  useEffect(() => {
    requestSeq.current += 1
    setGraph(null)
    setGraphLoading(false)
  }, [bookId])

  const loadGraph = useCallback(
    async (): Promise<{ error: string; msg: string }> => {
      if (!bookId) return { error: '', msg: '' }
      const seq = ++requestSeq.current
      setGraphLoading(true)

      try {
        const data = await getGraph(bookId, {
          chapter: filters.chapterFocus.mode === 'all' ? undefined : filters.chapterFocus.chapter,
          chapter_mode: filters.chapterFocus.mode === 'all' ? undefined : filters.chapterFocus.mode,
          min_appearance: filters.minAppearance,
          category_filter: filters.categoryFilter.length ? filters.categoryFilter.join(',') : undefined,
          predicate_filter: filters.typeFilter.length
            ? filters.typeFilter.join(',')
            : undefined,
        })
        if (seq !== requestSeq.current) return { error: '', msg: '' }
        setGraph(data)

        let rangeLabel = ' · 无章数据'
        if (data.chapter_focus) {
          const { chapter, mode } = data.chapter_focus
          rangeLabel =
            mode === 'single'
              ? ` · 仅「${chapterLabel(chapter)}」`
              : ` · 前 ${chapter} 章（累计）`
        } else if (data.chapter_range?.length >= 2) {
          rangeLabel = ' · 全书'
        }

        const msg =
          `图：${data.nodes.length} 人 · ${data.edges.length} 边` +
          rangeLabel +
          (data.filtered_count ? ` · 隐藏路人 ${data.filtered_count}` : '')

        return { error: '', msg }
      } catch (e) {
        if (seq !== requestSeq.current) return { error: '', msg: '' }
        setGraph(null)
        return { error: e instanceof Error ? e.message : String(e), msg: '' }
      } finally {
        if (seq === requestSeq.current) setGraphLoading(false)
      }
    },
    [
      bookId,
      filters.chapterFocus.mode,
      filters.chapterFocus.chapter,
      filters.minAppearance,
      filters.typeFilter,
      filters.categoryFilter,
      chapterLabel,
    ],
  )

  return { graph, graphLoading, loadGraph }
}
