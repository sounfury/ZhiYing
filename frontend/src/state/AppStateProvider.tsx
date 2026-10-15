/**
 * 全局应用状态：当前书、章节聚焦与过滤、图数据、选中与人物聚焦、侧栏页签、分析任务、导出、人名册与章节结果。
 * 只做编排（读接口、调 hook、写状态），具体展示交给各组件。
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  analysisChapters,
  clearAnalysis,
  deleteBook,
  splitBook,
  downloadExport,
  getBook,
  uploadBook,
  type BookMeta,
} from '../api'
import { bookLink, readBookLink } from '../bookLinks'
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
import { shortTitle } from '../labels'
import { AppStateContext, type AppStateValue } from './appStateContext'
import { useAuth } from '../useAuth'

const BOOK_KEY = 'zhiying.bookId'
const REUSE_MESSAGE = '这本书已有分析结果，已直接加载'

/** 初始选中的书：URL ?book= 优先，其次上次打开的书 */
function initialBookId(): string {
  try {
    const link = readBookLink(window.location.search)
    if (link.example) return ''
    if (link.book) return link.book
    return localStorage.getItem(BOOK_KEY) ?? ''
  } catch {
    return ''
  }
}

export function AppStateProvider({ children }: { children: ReactNode }) {
  const { user, openAccount } = useAuth()
  const isAdmin = user?.role === 'ADMIN'
  const { books, booksLoaded, publicOnly, booksError, refreshBooks } = useBooks()
  const [initialLink, setInitialLink] = useState(() => readBookLink(window.location.search))
  const [bookId, setBookId] = useState(initialBookId)
  // 先按当前会话的书架确认归属，再加载记忆或链接中的书。
  const readableBookId = booksLoaded && books.some((book) => book.book_id === bookId) ? bookId : ''

  // 记住当前书，刷新后直接回到它
  useEffect(() => {
    try {
      if (bookId) localStorage.setItem(BOOK_KEY, bookId)
      else localStorage.removeItem(BOOK_KEY)
    } catch {
      /* 无法写 localStorage 时不记忆 */
    }
  }, [bookId])

  // 固定公开链接优先于本机记忆；无链接的新访客直接打开第一本已发布示例。
  useEffect(() => {
    if (!booksLoaded) return
    if (initialLink.example) {
      const example = books.find((b) => b.example_slug === initialLink.example)
      setBookId(example?.book_id ?? '')
      if (!example) setError('这本示例书尚未开放或链接已失效')
      setInitialLink((prev) => ({ ...prev, example: '', book: example?.book_id ?? prev.example }))
    } else if (bookId && !books.some((b) => b.book_id === bookId)) {
      setBookId('')
      setError('这本书不存在或尚未开放')
    } else if (!bookId && !initialLink.book) {
      const example = books.find((b) => b.example_slug && b.status === 'analyzed')
      if (example) setBookId(example.book_id)
    }
  }, [bookId, books, booksLoaded, initialLink])
  const [bookDetail, setBookDetail] = useState<BookMeta | undefined>(undefined)

  const [chaptersVersion, setChaptersVersion] = useState(0)
  const { contentChapters, chapterLabel } = useChapters(readableBookId, (list) => {
    const allowed = new Set(analysisChapters(list).map((c) => c.chapter_id))
    setToChapter((prev) => (prev !== '' && allowed.has(prev) ? prev : ''))
  }, chaptersVersion)

  const [toChapter, setToChapter] = useState<number | ''>('')
  const [chapterFocus, setChapterFocusRaw] = useState<ChapterFocusState>(initialLink.chapterFocus)
  // 人物宣传链接可直接定位到默认被路人过滤隐藏的人物。
  const [minAppearance, setMinAppearance] = useState(initialLink.person ? 0 : 2)
  const [categoryFilter, setCategoryFilter] = useState<string[]>([])
  const [typeFilter, setTypeFilter] = useState<string[]>([])

  const filters: GraphFilters = {
    chapterFocus,
    minAppearance,
    typeFilter,
    categoryFilter,
  }

  const { graph, graphLoading, loadGraph } = useGraphData(readableBookId, filters, chapterLabel)
  const relationTypes = useRelationTypes(readableBookId, graph)

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

  useEffect(() => {
    if (!contentChapters.length || chapterFocus.mode === 'all') return
    if (!contentChapters.some((c) => c.chapter_id === chapterFocus.chapter)) {
      setChapterFocusRaw(ALL_BOOK_FOCUS)
      setMsg('链接中的章节不存在，已打开全书关系图')
    }
  }, [contentChapters, chapterFocus])

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
  } = useLedger(readableBookId, chapterFocus.mode === 'single' ? chapterFocus.chapter : '')

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
  const [exportingPng, setExportingPng] = useState(false)
  const [rerunRequestId, setRerunRequestId] = useState<number | null>(null)

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
    setMsg((previous) => !err && previous === REUSE_MESSAGE ? previous : m)
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

  const { cast, loading: castLoading, refresh: refreshCast } = useCast(readableBookId)

  const {
    entries: chapterLedgers,
    request: requestChapterLedger,
    invalidate: invalidateChapterLedgers,
  } = useChapterLedgers(readableBookId)

  const {
    analysis, start: startAnalysis, stop: stopAnalysis, resume: resumeAnalysis,
    dismiss: dismissAnalysis,
    disconnect: disconnectAnalysis, isRunning, pushLog, rerun: rerunAnalysis,
  } = useAnalysis({
      chapterLabel,
      onAnalysisDone: async () => {
        // 图由书详情刷新后的 effect 重载，这里不再重复加载
        await refreshBooks()
        await refreshCast()
        invalidateChapterLedgers()
        await refreshFocusLedger()
      },
      onBanner: (err, m) => {
        setError(err)
        setMsg(m)
      },
    })

  // 重读中的章以任务快照为准（刷新页面、失败重试也能显示）；快照尚未返回时用本地请求的章
  const rerunningChapterId =
    rerunRequestId ?? (analysis.running && analysis.task?.kind === 'rerun' ? (analysis.task.chapters[0]?.chapter_id ?? null) : null)

  // 选中的书：详情优先（含 analysis_progress），否则用列表项
  useEffect(() => {
    if (!readableBookId) {
      setBookDetail(undefined)
      return
    }
    let cancelled = false
    setBookDetail(undefined)
    void getBook(readableBookId)
      .then((b) => {
        if (!cancelled) setBookDetail(b)
      })
      .catch(() => {
        if (!cancelled) setBookDetail(undefined)
      })
    return () => {
      cancelled = true
    }
  }, [readableBookId, books])

  const selectedBook = bookDetail ?? books.find((b) => b.book_id === bookId)
  const serverRunning = selectedBook?.status === 'analyzing' || selectedBook?.status === 'reconciling'
  const effectiveRunning = (!selectedBook?.example_slug || isAdmin) && (isRunning || serverRunning)

  // 运行中则接上进度；最近一次失败则展示失败章与原因（PRD §5.9）
  useEffect(() => {
    if (!bookId || !bookDetail || (bookDetail.example_slug && !isAdmin)) return
    if (['analyzing', 'reconciling', 'failed'].includes(bookDetail.status)) {
      void resumeAnalysis(bookId)
    }
  }, [bookId, bookDetail, isAdmin, resumeAnalysis])

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
      if (!user || publicOnly) {
        openAccount('login')
        return
      }
      setError('')
      setMsg('')
      try {
        const res = await uploadBook(file)
        disconnectAnalysis()
        setBookDetail(undefined)
        const message = res.reused
          ? REUSE_MESSAGE
          : res.existing ? `已打开「${res.title}」` : `已上传「${res.title}」，可以启动分析`
        pushLog('ok', message)
        setMsg(message)
        const uploaded = (await refreshBooks()).find((b) => b.book_id === res.book_id)
        if (uploaded) window.history.replaceState(null, '', bookLink(window.location.href, uploaded, ALL_BOOK_FOCUS, null))
        setInitialLink({ example: '', book: res.book_id, person: '', chapterFocus: ALL_BOOK_FOCUS })
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
    [user, publicOnly, openAccount, pushLog, refreshBooks, disconnectAnalysis],
  )

  const onAnalyze = useCallback(async (opts?: { force?: boolean }) => {
    if (!bookId || publicOnly || (selectedBook?.example_slug && !isAdmin)) return
    await startAnalysis(bookId, toChapter, opts?.force ?? false)
  }, [bookId, publicOnly, selectedBook, isAdmin, startAnalysis, toChapter])

  const onStop = useCallback(async () => {
    if (!bookId || publicOnly || (selectedBook?.example_slug && !isAdmin)) return
    await stopAnalysis(bookId)
  }, [bookId, publicOnly, selectedBook, isAdmin, stopAnalysis])

  /** 失败后的补救：整书分析 = 再次启动（不 force，只补读失败章）；单章重跑 = 再重跑那一章 */
  const onRetryFailed = useCallback(async () => {
    if (!bookId || publicOnly || (selectedBook?.example_slug && !isAdmin)) return
    const task = analysis.task
    if (task?.kind === 'rerun' && task.chapters[0]) {
      await rerunAnalysis(bookId, task.chapters[0].chapter_id)
      return
    }
    await startAnalysis(bookId, toChapter, false)
  }, [bookId, publicOnly, selectedBook, isAdmin, analysis.task, rerunAnalysis, startAnalysis, toChapter])

  const handleBookChange = useCallback((newBookId: string) => {
    disconnectAnalysis()
    setMsg('')
    setInitialLink({ example: '', book: newBookId, person: '', chapterFocus: ALL_BOOK_FOCUS })
    const book = books.find((b) => b.book_id === newBookId)
    if (book) window.history.replaceState(null, '', bookLink(window.location.href, book, ALL_BOOK_FOCUS, null))
    setBookId(newBookId)
    setChapterFocusRaw(ALL_BOOK_FOCUS)
    setEgoPersonId(null)
    setSelectedNode(null)
    setSelectedEdge(null)
    setTypeFilter([])
    setCategoryFilter([])
    setSelectedFactions([])
    setSideTab('detail')
  }, [disconnectAnalysis, books])

  const onDeleteBook = useCallback(
    async (id: string) => {
      if (publicOnly || !books.some((b) => b.book_id === id && !b.example_slug)) return
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
    [publicOnly, books, bookId, handleBookChange, refreshBooks],
  )

  const onClearAnalysis = useCallback(
    async (id: string, rule?: string) => {
      if (publicOnly || !books.some((b) => b.book_id === id && !b.example_slug)) return
      const title = books.find((b) => b.book_id === id)?.title ?? ''
      setError('')
      setMsg('')
      try {
        if (rule) await splitBook(id, rule)
        else await clearAnalysis(id)
        if (rule && id === bookId) setChaptersVersion((v) => v + 1)
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
        setMsg(rule ? `已重新切分「${title}」的章节，可以重新分析` : `已清空「${title}」的分析结果，可以重新分析`)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
    },
    [publicOnly, books, bookId, disconnectAnalysis, invalidateChapterLedgers, refreshBooks, refreshCast, refreshFocusLedger],
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

  const onExportPng = useCallback<AppStateValue['onExportPng']>(
    async (render) => {
      if (!selectedBook) return
      setExportingPng(true)
      setError('')
      // 服务端筛选不在场景里，写进图片的范围说明，免得别人看图以为是全部关系
      const notes: string[] = []
      if (categoryFilter.length || typeFilter.length) notes.push('已按关系类型筛选')
      if (minAppearance !== 2) notes.push(`只含出场 ≥ ${minAppearance} 章的人物`)
      try {
        const res = await render({ bookTitle: shortTitle(selectedBook.title), notes })
        const blurry = res.scale < 2 ? '；图较大，已降低清晰度，可筛选势力或进入中心视图后再导出' : ''
        setMsg(`已导出 ${res.filename}（${res.width}×${res.height}${blurry}）`)
        pushLog('ok', `导出图片 ${res.filename}（${res.width}×${res.height}）`)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setExportingPng(false)
      }
    },
    [selectedBook, categoryFilter, typeFilter, minAppearance, pushLog],
  )

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
        cast?.persons.find((p) => p.person_id === personId)?.name ??
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
      if (!bookId || publicOnly || (selectedBook?.example_slug && !isAdmin) || rerunningChapterId != null) return
      setRerunRequestId(chapterId)
      try {
        await rerunAnalysis(bookId, chapterId)
      } finally {
        setRerunRequestId(null)
      }
    },
    [bookId, publicOnly, selectedBook, isAdmin, rerunningChapterId, rerunAnalysis],
  )

  const personName = useCallback(
    (personId: string) =>
      graph?.nodes.find((n) => n.person_id === personId)?.name ??
      cast?.persons.find((p) => p.person_id === personId)?.name ??
      personId,
    [graph, cast],
  )

  useEffect(() => {
    if (!initialLink.person || !graph || graph.book_id !== bookId || graphLoading) return
    const node = graph.nodes.find((n) => n.person_id === initialLink.person)
    if (node) {
      setSelectedNode(node)
      setEgoPersonId(node.person_id)
      setFocusRequest({ personId: node.person_id, nonce: Date.now() })
    } else {
      setMsg('链接中的人物不在当前章节范围内，已打开关系图')
    }
    setInitialLink((prev) => ({ ...prev, person: '' }))
  }, [initialLink.person, graph, bookId, graphLoading])

  // 身份变化会重建状态树；示例链接保留当前章节与人物，登录后仍回到这张图。
  useEffect(() => {
    if (!selectedBook?.example_slug || !graph || graphLoading) return
    window.history.replaceState(null, '', bookLink(window.location.href, selectedBook, chapterFocus, egoPersonId ?? selectedNode?.person_id ?? null))
  }, [selectedBook, graph, graphLoading, chapterFocus, egoPersonId, selectedNode])

  const onShare = useCallback(async () => {
    if (!selectedBook) return
    const url = bookLink(window.location.href, selectedBook, chapterFocus, egoPersonId ?? selectedNode?.person_id ?? null)
    window.history.replaceState(null, '', url)
    try {
      await navigator.clipboard.writeText(url)
      setMsg('已复制当前视图链接')
    } catch {
      setMsg(`当前视图链接：${url}`)
    }
  }, [selectedBook, chapterFocus, egoPersonId, selectedNode])

  const value = useMemo<AppStateValue>(
    () => ({
      books,
      publicOnly,
      onShare,
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
      error: error || booksError,
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
      onExportPng,
      exportingPng,
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
      publicOnly,
      booksError,
      onShare,
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
      onExportPng,
      exportingPng,
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
