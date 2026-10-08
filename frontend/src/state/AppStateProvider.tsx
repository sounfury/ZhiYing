/**
 * 全局应用状态：当前书、章节聚焦与过滤、图数据、选中与人物聚焦、侧栏页签、分析任务、导出、人名册与章节结果。
 * 只做编排（读接口、调 hook、写状态），具体展示交给各组件。
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  analysisChapters,
  clearAnalysis,
  deleteBook,
  downloadExport,
  getBook,
  uploadBook,
  type BookMeta,
} from '../api'
import type { FocusRequest, LayoutMode } from '../components/GraphView'
import type { PersonHit } from '../components/PersonSearch'
import { useBooks } from '../hooks/useBooks'
import { useCast } from '../hooks/useCast'
import { useChapters } from '../hooks/useChapters'
import { useGraphData } from '../hooks/useGraphData'
import { useAnalysis } from '../hooks/useAnalysis'
import { useChapterLedgers, useLedger } from '../hooks/useLedger'
import { useRelationTypes } from '../hooks/useRelationTypes'
import { ALL_BOOK_FOCUS, type ChapterFocusState, type GraphFilters, type SideTab } from '../types'
import { chapterShortName } from '../chapterNames'
import { AppStateContext, type AppStateValue } from './appStateContext'

const BOOK_KEY = 'zhiying.bookId'

/** 初始选中的书：URL ?book= 优先，其次上次打开的书 */
function initialBookId(): string {
  try {
    const fromUrl = new URLSearchParams(window.location.search).get('book')
    if (fromUrl) return fromUrl
    return localStorage.getItem(BOOK_KEY) ?? ''
  } catch {
    return ''
  }
}

export function AppStateProvider({ children }: { children: ReactNode }) {
  const { books, booksLoaded, refreshBooks } = useBooks()
  const [bookId, setBookId] = useState(initialBookId)

  // 记住当前书，刷新后直接回到它
  useEffect(() => {
    try {
      if (bookId) localStorage.setItem(BOOK_KEY, bookId)
      else localStorage.removeItem(BOOK_KEY)
    } catch {
      /* 无法写 localStorage 时不记忆 */
    }
  }, [bookId])

  // 记住的书已被删除：书单加载后找不到就回到空态
  useEffect(() => {
    if (bookId && booksLoaded && !books.some((b) => b.book_id === bookId)) setBookId('')
  }, [bookId, books, booksLoaded])
  const [bookDetail, setBookDetail] = useState<BookMeta | undefined>(undefined)

  const { contentChapters, chapterLabel } = useChapters(bookId, (list) => {
    const allowed = new Set(analysisChapters(list).map((c) => c.chapter_id))
    setToChapter((prev) => (prev !== '' && allowed.has(prev) ? prev : ''))
  })

  const [toChapter, setToChapter] = useState<number | ''>('')
  const [chapterFocus, setChapterFocusRaw] = useState<ChapterFocusState>(ALL_BOOK_FOCUS)
  // 路人过滤默认「至少出场 2 章」（PRD §5.7.7）
  const [minAppearance, setMinAppearance] = useState(2)
  const [categoryFilter, setCategoryFilter] = useState<string[]>([])
  const [typeFilter, setTypeFilter] = useState<string[]>([])

  const filters: GraphFilters = {
    chapterFocus,
    minAppearance,
    typeFilter,
    categoryFilter,
  }

  const { graph, graphLoading, loadGraph } = useGraphData(bookId, filters, chapterLabel)
  const relationTypes = useRelationTypes(bookId, graph)

  /** 切换章节聚焦：从「全书」切到单章/前 N 章时，章节缺省取已有选择或第一章；章节不在可选范围时回落第一章 */
  const setChapterFocus = useCallback(
    (next: ChapterFocusState) => {
      if (next.mode === 'all') {
        setChapterFocusRaw(ALL_BOOK_FOCUS)
        return
      }
      const ids = contentChapters.map((c) => c.chapter_id)
      const chapter = ids.includes(next.chapter) ? next.chapter : (ids[0] ?? 0)
      if (!chapter) return
      setChapterFocusRaw({ mode: next.mode, chapter })
    },
    [contentChapters],
  )

  /** 当前范围说明（图例 / 导出提示用），以后端返回的 chapter_focus 为准 */
  const scopeLabel = useMemo(() => {
    const f = graph?.chapter_focus
    if (!f) return '全书'
    // chapter 是章节 id，不是正文序号；显示用正文里的序号与短名
    const i = contentChapters.findIndex((c) => c.chapter_id === f.chapter)
    if (i < 0) return f.mode === 'single' ? chapterLabel(f.chapter) : `截至「${chapterLabel(f.chapter)}」`
    return f.mode === 'single' ? chapterShortName(contentChapters, f.chapter) : `前 ${i + 1} 章`
  }, [graph, chapterLabel, contentChapters])

  // 单章聚焦时取该章结果，详情里显示本章摘要
  const {
    ledger: focusLedger,
    loading: focusLedgerLoading,
    refresh: refreshFocusLedger,
  } = useLedger(bookId, chapterFocus.mode === 'single' ? chapterFocus.chapter : '')

  const [layoutMode, setLayoutMode] = useState<LayoutMode>('faction')
  const [selectedFactions, setSelectedFactions] = useState<string[]>([])

  useEffect(() => {
    if (!selectedFactions.length) return
    const alive = new Set((graph?.factions ?? []).map((f) => f.faction_id))
    const next = selectedFactions.filter((id) => alive.has(id))
    if (next.length !== selectedFactions.length) setSelectedFactions(next)
  }, [graph, selectedFactions])

  const [selectedEdge, setSelectedEdge] = useState<AppStateValue['selectedEdge']>(null)
  const [selectedNode, setSelectedNode] = useState<AppStateValue['selectedNode']>(null)
  const [egoPersonId, setEgoPersonId] = useState<string | null>(null)
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null)

  const [sideTab, setSideTab] = useState<SideTab>('detail')
  const openSide = setSideTab
  /** 递增即让图重新适应窗口（GraphView 的 refitToken） */
  const [refitToken, setRefitToken] = useState(0)
  const requestRefit = useCallback(() => setRefitToken((t) => t + 1), [])

  const [error, setError] = useState('')
  const [msg, setMsg] = useState('')
  const clearBanner = useCallback(() => {
    setError('')
    setMsg('')
  }, [])
  const [exporting, setExporting] = useState(false)
  const [rerunningChapterId, setRerunningChapterId] = useState<number | null>(null)

  const handleLoadGraph = useCallback(async () => {
    setError('')
    setEgoPersonId(null)
    const { error: err, msg: m } = await loadGraph()
    if (err.startsWith('409:') && bookId) {
      try {
        const fresh = await getBook(bookId)
        setBookDetail(fresh)
        if (fresh.status === 'analyzing' || fresh.status === 'reconciling') {
          setError('')
          setMsg('分析进行中，完成后会自动更新关系图')
          return
        }
      } catch {
        // Fall through to the original graph error.
      }
    }
    setError(err)
    setMsg(m)
  }, [bookId, loadGraph])

  // 图重新加载（换章节范围 / 过滤）后，选中的人或连线若仍在图上就换成新对象，不在则取消选中
  useEffect(() => {
    const nodes = graph?.nodes ?? []
    setSelectedNode((prev) => (prev ? (nodes.find((n) => n.person_id === prev.person_id) ?? null) : null))
    setSelectedEdge((prev) =>
      prev
        ? ((graph?.edges ?? []).find(
            (e) => e.person_a === prev.person_a && e.person_b === prev.person_b,
          ) ?? null)
        : null,
    )
  }, [graph])

  const { cast, loading: castLoading, refresh: refreshCast } = useCast(bookId)

  const {
    entries: chapterLedgers,
    request: requestChapterLedger,
    invalidate: invalidateChapterLedgers,
  } = useChapterLedgers(bookId)

  const {
    analysis, start: startAnalysis, stop: stopAnalysis, resume: resumeAnalysis,
    dismiss: dismissAnalysis,
    disconnect: disconnectAnalysis, isRunning, pushLog, rerun: rerunAnalysis,
  } = useAnalysis({
      chapterLabel,
      onAnalysisDone: async () => {
        await refreshBooks()
        await handleLoadGraph()
        await refreshCast()
        invalidateChapterLedgers()
        await refreshFocusLedger()
      },
      onBanner: (err, m) => {
        setError(err)
        setMsg(m)
      },
    })

  // 选中的书：详情优先（含 analysis_progress），否则用列表项
  useEffect(() => {
    if (!bookId) {
      setBookDetail(undefined)
      return
    }
    let cancelled = false
    setBookDetail(undefined)
    void getBook(bookId)
      .then((b) => {
        if (!cancelled) setBookDetail(b)
      })
      .catch(() => {
        if (!cancelled) setBookDetail(undefined)
      })
    return () => {
      cancelled = true
    }
  }, [bookId, books])

  const selectedBook = bookDetail ?? books.find((b) => b.book_id === bookId)
  const serverRunning = selectedBook?.status === 'analyzing' || selectedBook?.status === 'reconciling'
  const effectiveRunning = isRunning || serverRunning

  // 运行中则接上进度；最近一次失败则展示失败章与原因（PRD §5.9）
  useEffect(() => {
    if (!bookId || !bookDetail) return
    if (['analyzing', 'reconciling', 'failed'].includes(bookDetail.status)) {
      void resumeAnalysis(bookId)
    }
  }, [bookId, bookDetail, resumeAnalysis])

  useEffect(() => {
    document.title = selectedBook?.title
      ? `${selectedBook.title} · 织影`
      : '织影 · 人物关系图谱'
  }, [selectedBook])

  // 书切换 / 过滤变化 → 自动刷新图（分析中不打断）
  useEffect(() => {
    // Wait for fresh server metadata before deciding whether graph reads are legal.
    // This prevents a page refresh from issuing a transient 409 while analysis is active.
    if (bookId && bookDetail && !effectiveRunning) void handleLoadGraph()
  }, [bookId, bookDetail, handleLoadGraph, effectiveRunning])

  const onUpload = useCallback(
    async (file: File | null) => {
      if (!file) return
      setError('')
      setMsg('')
      try {
        const res = await uploadBook(file)
        pushLog('ok', `已上传：${res.title}`)
        setMsg(`已上传「${res.title}」，可以启动分析`)
        await refreshBooks()
        setBookId(res.book_id)
        setChapterFocusRaw(ALL_BOOK_FOCUS)
        setTypeFilter([])
        setCategoryFilter([])
        setEgoPersonId(null)
        setSelectedNode(null)
        setSelectedEdge(null)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
    },
    [pushLog, refreshBooks],
  )

  const onAnalyze = useCallback(async (opts?: { force?: boolean }) => {
    if (!bookId) return
    await startAnalysis(bookId, toChapter, opts?.force ?? false)
  }, [bookId, startAnalysis, toChapter])

  const onStop = useCallback(async () => {
    if (!bookId) return
    await stopAnalysis(bookId)
  }, [bookId, stopAnalysis])

  /** 失败后的补救：整书分析 = 再次启动（不 force，只补读失败章）；单章重跑 = 再重跑那一章 */
  const onRetryFailed = useCallback(async () => {
    if (!bookId) return
    const task = analysis.task
    if (task?.kind === 'rerun' && task.chapters[0]) {
      await rerunAnalysis(bookId, task.chapters[0].chapter_id)
      return
    }
    await startAnalysis(bookId, toChapter, false)
  }, [bookId, analysis.task, rerunAnalysis, startAnalysis, toChapter])

  const handleBookChange = useCallback((newBookId: string) => {
    disconnectAnalysis()
    setBookId(newBookId)
    setChapterFocusRaw(ALL_BOOK_FOCUS)
    setEgoPersonId(null)
    setSelectedNode(null)
    setSelectedEdge(null)
    setTypeFilter([])
    setCategoryFilter([])
    setSelectedFactions([])
    setSideTab('detail')
  }, [disconnectAnalysis])

  const onDeleteBook = useCallback(
    async (id: string) => {
      const title = books.find((b) => b.book_id === id)?.title ?? ''
      setError('')
      setMsg('')
      try {
        await deleteBook(id)
        if (id === bookId) handleBookChange('')
        await refreshBooks()
        setMsg(`已删除「${title}」`)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
    },
    [books, bookId, handleBookChange, refreshBooks],
  )

  const onClearAnalysis = useCallback(
    async (id: string) => {
      const title = books.find((b) => b.book_id === id)?.title ?? ''
      setError('')
      setMsg('')
      try {
        await clearAnalysis(id)
        if (id === bookId) {
          // 进度卡、选中与人物聚焦都属于旧结果；图随书详情刷新后自动重载为空
          disconnectAnalysis()
          setEgoPersonId(null)
          setSelectedNode(null)
          setSelectedEdge(null)
          setSelectedFactions([])
          invalidateChapterLedgers()
        }
        await refreshBooks()
        if (id === bookId) {
          await refreshCast()
          await refreshFocusLedger()
        }
        setMsg(`已清空「${title}」的分析结果，可以重新分析`)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
    },
    [books, bookId, disconnectAnalysis, invalidateChapterLedgers, refreshBooks, refreshCast, refreshFocusLedger],
  )

  const onExport = useCallback(async () => {
    if (!bookId) return
    setExporting(true)
    setError('')
    try {
      const filename = await downloadExport(bookId, chapterFocus.mode === 'all' ? null : { mode: chapterFocus.mode, chapter: chapterFocus.chapter })
      setMsg(`已导出 ${filename}（范围：${scopeLabel}）`)
      pushLog('ok', `导出 ${filename}（范围：${scopeLabel}）`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setExporting(false)
    }
  }, [bookId, chapterFocus, scopeLabel, pushLog])

  const onPickPerson = useCallback(
    (hit: PersonHit) => {
      setError('')
      if (hit.filtered) {
        setMsg(
          `「${hit.name}」出场不足 ${minAppearance} 章，被当作路人隐藏了；在筛选里调低路人阈值后可在图上看到`,
        )
        return
      }

      const node = graph?.nodes.find((n) => n.person_id === hit.personId)
      if (!node) return

      setEgoPersonId(null)
      if (
        selectedFactions.length &&
        (!node.primary_faction_id ||
          !selectedFactions.includes(node.primary_faction_id))
      ) {
        setSelectedFactions([])
        setMsg(`「${hit.name}」不在当前筛选的势力里，已恢复全部势力块`)
      } else {
        setMsg('')
      }

      setSelectedEdge(null)
      setSelectedNode(node)
      openSide('detail')
      setFocusRequest((prev) => ({
        personId: hit.personId,
        nonce: (prev?.nonce ?? 0) + 1,
      }))
    },
    [graph, minAppearance, selectedFactions, openSide],
  )

  const onFocusCastPerson = useCallback(
    (personId: string) => {
      const node = graph?.nodes.find((n) => n.person_id === personId)
      const name =
        node?.name ??
        cast?.persons.find((p) => p.person_id === personId)?.canonical_name ??
        personId
      if (!node) {
        setMsg(`「${name}」当前不在图上（可能被过滤，或尚未入图）`)
        return
      }
      onPickPerson({
        personId: node.person_id,
        name: node.name,
        aliases: node.aliases,
        importance: node.importance,
        appearanceCount: node.appearance_count,
        filtered: false,
      })
    },
    [graph, cast, onPickPerson],
  )

  /** 单章重跑：进度与提示走分析任务（useAnalysis），完成后由 onAnalysisDone 刷新图、人名册与章节结果 */
  const onRerunChapter = useCallback(
    async (chapterId: number) => {
      if (!bookId || rerunningChapterId != null) return
      setRerunningChapterId(chapterId)
      try {
        await rerunAnalysis(bookId, chapterId)
      } finally {
        setRerunningChapterId(null)
      }
    },
    [bookId, rerunningChapterId, rerunAnalysis],
  )

  const personName = useCallback(
    (personId: string) =>
      graph?.nodes.find((n) => n.person_id === personId)?.name ??
      cast?.persons.find((p) => p.person_id === personId)?.canonical_name ??
      personId,
    [graph, cast],
  )

  const value = useMemo<AppStateValue>(
    () => ({
      books,
      bookId,
      selectedBook,
      handleBookChange,
      contentChapters,
      chapterLabel,
      toChapter,
      setToChapter,
      chapterFocus,
      setChapterFocus,
      scopeLabel,
      focusLedger,
      focusLedgerLoading,
      minAppearance,
      setMinAppearance,
      typeFilter,
      categoryFilter,
      setTypeFilter,
      setCategoryFilter,
      relationTypes,
      graph,
      graphLoading,
      layoutMode,
      setLayoutMode,
      selectedFactions,
      setSelectedFactions,
      selectedEdge,
      setSelectedEdge,
      selectedNode,
      setSelectedNode,
      egoPersonId,
      setEgoPersonId,
      focusRequest,
      sideTab,
      refitToken,
      requestRefit,
      openSide,
      error,
      msg,
      clearBanner,
      analysis,
      isRunning: effectiveRunning,
      onUpload,
      onDeleteBook,
      onClearAnalysis,
      onAnalyze,
      onStop,
      onRetryFailed,
      onDismissAnalysis: dismissAnalysis,
      onPickPerson,
      onExport,
      exporting,
      cast,
      castLoading,
      onFocusCastPerson,
      chapterLedgers,
      requestChapterLedger,
      rerunningChapterId,
      onRerunChapter,
      personName,
    }),
    [
      books,
      bookId,
      selectedBook,
      handleBookChange,
      contentChapters,
      chapterLabel,
      toChapter,
      chapterFocus,
      setChapterFocus,
      scopeLabel,
      focusLedger,
      focusLedgerLoading,
      minAppearance,
      typeFilter,
      categoryFilter,
      relationTypes,
      graph,
      graphLoading,
      layoutMode,
      selectedFactions,
      selectedEdge,
      selectedNode,
      egoPersonId,
      focusRequest,
      sideTab,
      refitToken,
      requestRefit,
      openSide,
      error,
      msg,
      clearBanner,
      analysis,
      effectiveRunning,
      onUpload,
      onDeleteBook,
      onClearAnalysis,
      onAnalyze,
      onStop,
      onRetryFailed,
      dismissAnalysis,
      onPickPerson,
      onExport,
      exporting,
      cast,
      castLoading,
      onFocusCastPerson,
      chapterLedgers,
      requestChapterLedger,
      rerunningChapterId,
      onRerunChapter,
      personName,
    ],
  )

  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>
}
