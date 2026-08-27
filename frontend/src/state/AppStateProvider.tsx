import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  analysisChapters,
  downloadExport,
  extractFactions,
  getBook,
  rerunChapter,
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
import { useLedger } from '../hooks/useLedger'
import { useRelationTypes } from '../hooks/useRelationTypes'
import type { GraphFilters, SideTab } from '../types'
import { AppStateContext, type AppStateValue } from './appStateContext'

export function AppStateProvider({ children }: { children: ReactNode }) {
  const { books, refreshBooks } = useBooks()
  const [bookId, setBookId] = useState('')
  const [bookDetail, setBookDetail] = useState<BookMeta | undefined>(undefined)

  const { contentChapters, chapterLabel } = useChapters(bookId, (list) => {
    const allowed = new Set(analysisChapters(list).map((c) => c.chapter_id))
    setToChapter((prev) => (prev !== '' && allowed.has(prev) ? prev : ''))
    setSingleChapterOnly(false)
    setLedgerChapterId((prev) => (prev !== '' && allowed.has(prev) ? prev : ''))
  })

  const [toChapter, setToChapter] = useState<number | ''>('')
  const [singleChapterOnly, setSingleChapterOnly] = useState(false)
  const [minAppearance, setMinAppearance] = useState(1)
  const [includeSuppressed, setIncludeSuppressed] = useState(false)
  const [typeFilter, setTypeFilter] = useState<string[]>([])
  const relationTypes = useRelationTypes()

  const filters: GraphFilters = {
    toChapter,
    singleChapterOnly,
    minAppearance,
    includeSuppressed,
    typeFilter,
  }

  const { graph, graphLoading, loadGraph } = useGraphData(bookId, filters, chapterLabel)

  const [layoutMode, setLayoutMode] = useState<LayoutMode>('faction')
  const [selectedFactions, setSelectedFactions] = useState<string[]>([])
  const [factionLoading, setFactionLoading] = useState(false)

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

  const [sideCollapsed, setSideCollapsed] = useState(false)
  const [sideTab, setSideTab] = useState<SideTab>('detail')
  const [refitToken, setRefitToken] = useState(0)
  const sideCollapsedRef = useRef(false)
  sideCollapsedRef.current = sideCollapsed
  const toggleSide = useCallback(() => {
    setSideCollapsed((v) => !v)
    setRefitToken((t) => t + 1)
  }, [])

  const openSide = useCallback((tab: SideTab) => {
    setSideTab(tab)
    if (sideCollapsedRef.current) {
      setSideCollapsed(false)
      setRefitToken((t) => t + 1)
    }
  }, [])

  const [error, setError] = useState('')
  const [msg, setMsg] = useState('')
  const [exporting, setExporting] = useState(false)
  const [rerunning, setRerunning] = useState(false)

  const handleLoadGraph = useCallback(async () => {
    setError('')
    setSelectedEdge(null)
    setSelectedNode(null)
    setEgoPersonId(null)
    const { error: err, msg: m } = await loadGraph()
    setError(err)
    setMsg(m)
  }, [loadGraph])

  const {
    cast,
    loading: castLoading,
    saving: castSaving,
    error: castError,
    refresh: refreshCast,
    savePerson: saveCastPerson,
    merge: mergeCast,
  } = useCast(bookId)

  const [ledgerChapterId, setLedgerChapterId] = useState<number | ''>('')
  const {
    ledger,
    loading: ledgerLoading,
    missing: ledgerMissing,
    error: ledgerError,
    refresh: refreshLedger,
  } = useLedger(bookId, ledgerChapterId)

  const { analysis, start: startAnalysis, stop: stopAnalysis, isRunning, pushLog } =
    useAnalysis({
      chapterLabel,
      onAnalysisDone: async () => {
        await refreshBooks()
        await handleLoadGraph()
        await refreshCast()
        await refreshLedger()
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

  useEffect(() => {
    document.title = selectedBook?.title
      ? `${selectedBook.title} · 织影`
      : '织影 · 人物关系图谱'
  }, [selectedBook])

  // 书切换 / 过滤变化 → 自动刷新图（分析中不打断）
  useEffect(() => {
    if (bookId && !isRunning) void handleLoadGraph()
  }, [bookId, handleLoadGraph, isRunning])

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
        setEgoPersonId(null)
        setSelectedNode(null)
        setSelectedEdge(null)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
    },
    [pushLog, refreshBooks],
  )

  const onAnalyze = useCallback(async () => {
    if (!bookId) return
    await startAnalysis(bookId, toChapter)
  }, [bookId, startAnalysis, toChapter])

  const onStop = useCallback(async () => {
    if (!bookId) return
    await stopAnalysis(bookId)
  }, [bookId, stopAnalysis])

  const handleBookChange = useCallback((newBookId: string) => {
    setBookId(newBookId)
    setEgoPersonId(null)
    setSelectedNode(null)
    setSelectedEdge(null)
    setTypeFilter([])
    setSelectedFactions([])
    setSideTab('detail')
  }, [])

  const onExtractFactions = useCallback(async () => {
    if (!bookId) return
    setError('')
    setMsg('正在归纳势力块（单次 LLM 会话，约需 1 分钟）…')
    setFactionLoading(true)
    try {
      const res = await extractFactions(bookId)
      pushLog('ok', `势力归纳完成：${res.factions} 块 / ${res.members} 条归属`)
      setLayoutMode('faction')
      await handleLoadGraph()
      setMsg(`势力归纳完成：${res.factions} 块 · ${res.members} 条归属`)
    } catch (e) {
      setMsg('')
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setFactionLoading(false)
    }
  }, [bookId, handleLoadGraph, pushLog])

  const onExport = useCallback(async () => {
    if (!bookId) return
    setExporting(true)
    setError('')
    try {
      const filename = await downloadExport(bookId)
      setMsg(`已导出 ${filename}`)
      pushLog('ok', `导出 ${filename}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setExporting(false)
    }
  }, [bookId, pushLog])

  const onPickPerson = useCallback(
    (hit: PersonHit) => {
      setError('')
      if (hit.filtered) {
        setMsg(
          `「${hit.name}」被 min_appearance=${minAppearance} 过滤了，调低阈值后可在图上看到`,
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

  const saveCastPersonAndRefresh = useCallback(
    async (person: Parameters<typeof saveCastPerson>[0]) => {
      await saveCastPerson(person)
      await handleLoadGraph()
    },
    [saveCastPerson, handleLoadGraph],
  )

  const mergeCastAndRefresh = useCallback(
    async (keepId: string, dropId: string) => {
      await mergeCast(keepId, dropId)
      await handleLoadGraph()
      await refreshLedger()
    },
    [mergeCast, handleLoadGraph, refreshLedger],
  )

  const onRerunChapter = useCallback(async () => {
    if (!bookId || ledgerChapterId === '') return
    setRerunning(true)
    setError('')
    setMsg('正在重跑此章（覆盖该章账本，不级联）…')
    try {
      const res = await rerunChapter(bookId, ledgerChapterId)
      pushLog('ok', `重跑完成：第 ${res.chapter_id} 章 · ${res.steps_used} 步`)
      await refreshBooks()
      await refreshCast()
      await refreshLedger()
      await handleLoadGraph()
      setMsg(`重跑完成：${chapterLabel(res.chapter_id)}`)
    } catch (e) {
      setMsg('')
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setRerunning(false)
    }
  }, [
    bookId,
    ledgerChapterId,
    pushLog,
    refreshBooks,
    refreshCast,
    refreshLedger,
    handleLoadGraph,
    chapterLabel,
  ])

  const personName = useCallback(
    (personId: string) =>
      graph?.nodes.find((n) => n.person_id === personId)?.name ??
      cast?.persons.find((p) => p.person_id === personId)?.canonical_name ??
      personId,
    [graph, cast],
  )

  const openSideWithLedgerDefault = useCallback(
    (tab: SideTab) => {
      if (tab === 'ledger' && ledgerChapterId === '') {
        const hint = toChapter !== '' ? toChapter : contentChapters[0]?.chapter_id
        if (hint != null) setLedgerChapterId(hint)
      }
      openSide(tab)
    },
    [ledgerChapterId, toChapter, contentChapters, openSide],
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
      singleChapterOnly,
      setSingleChapterOnly,
      minAppearance,
      setMinAppearance,
      includeSuppressed,
      setIncludeSuppressed,
      typeFilter,
      setTypeFilter,
      relationTypes,
      graph,
      graphLoading,
      handleLoadGraph,
      layoutMode,
      setLayoutMode,
      selectedFactions,
      setSelectedFactions,
      factionLoading,
      selectedEdge,
      setSelectedEdge,
      selectedNode,
      setSelectedNode,
      egoPersonId,
      setEgoPersonId,
      focusRequest,
      sideCollapsed,
      sideTab,
      setSideTab,
      refitToken,
      toggleSide,
      openSide: openSideWithLedgerDefault,
      error,
      msg,
      analysis,
      isRunning,
      onUpload,
      onAnalyze,
      onStop,
      onExtractFactions,
      onPickPerson,
      onExport,
      exporting,
      cast,
      castLoading,
      castSaving,
      castError,
      saveCastPerson: saveCastPersonAndRefresh,
      mergeCast: mergeCastAndRefresh,
      onFocusCastPerson,
      ledgerChapterId,
      setLedgerChapterId,
      ledger,
      ledgerLoading,
      ledgerMissing,
      ledgerError,
      rerunning,
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
      singleChapterOnly,
      minAppearance,
      includeSuppressed,
      typeFilter,
      relationTypes,
      graph,
      graphLoading,
      handleLoadGraph,
      layoutMode,
      selectedFactions,
      factionLoading,
      selectedEdge,
      selectedNode,
      egoPersonId,
      focusRequest,
      sideCollapsed,
      sideTab,
      refitToken,
      toggleSide,
      openSideWithLedgerDefault,
      error,
      msg,
      analysis,
      isRunning,
      onUpload,
      onAnalyze,
      onStop,
      onExtractFactions,
      onPickPerson,
      onExport,
      exporting,
      cast,
      castLoading,
      castSaving,
      castError,
      saveCastPersonAndRefresh,
      mergeCastAndRefresh,
      onFocusCastPerson,
      ledgerChapterId,
      ledger,
      ledgerLoading,
      ledgerMissing,
      ledgerError,
      rerunning,
      onRerunChapter,
      personName,
    ],
  )

  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>
}
