import { useCallback, useEffect, useState } from 'react'
import {
  analysisChapters,
  extractFactions,
  uploadBook,
  type GraphEdge,
  type GraphNode,
} from './api'
import { GraphView, type FocusRequest, type LayoutMode } from './GraphView'
import { HeaderBar } from './components/HeaderBar'
import { ControlPanel } from './components/ControlPanel'
import { AnalysisProgress } from './components/AnalysisProgress'
import { DetailPanel } from './components/DetailPanel'
import type { PersonHit } from './components/PersonSearch'
import { useBooks } from './hooks/useBooks'
import { useChapters } from './hooks/useChapters'
import { useGraphData } from './hooks/useGraphData'
import { useAnalysis } from './hooks/useAnalysis'
import type { GraphFilters } from './types'
import './App.css'

export default function App() {
  // ── 书籍 ──
  const { books, refreshBooks } = useBooks()
  const [bookId, setBookId] = useState('')

  // ── 章节 ──
  const { contentChapters, chapterLabel } = useChapters(bookId, (list) => {
    // 书切换后校验 toChapter 仍合法
    const allowed = new Set(analysisChapters(list).map((c) => c.chapter_id))
    setToChapter((prev) => (prev !== '' && allowed.has(prev) ? prev : ''))
    setSingleChapterOnly(false)
  })

  // ── 图谱过滤 ──
  const [toChapter, setToChapter] = useState<number | ''>('')
  const [singleChapterOnly, setSingleChapterOnly] = useState(false)
  const [minAppearance, setMinAppearance] = useState(1)
  const [includeSuppressed, setIncludeSuppressed] = useState(false)

  const filters: GraphFilters = {
    toChapter,
    singleChapterOnly,
    minAppearance,
    includeSuppressed,
  }

  // ── 图数据 ──
  const { graph, graphLoading, loadGraph } = useGraphData(bookId, filters, chapterLabel)

  // ── 布局 ──
  const [layoutMode, setLayoutMode] = useState<LayoutMode>('faction')
  const [selectedFactions, setSelectedFactions] = useState<string[]>([])
  const [factionLoading, setFactionLoading] = useState(false)

  // 图重载后势力块可能变（换书 / 换章节切片）→ 剔除已失效的选择
  useEffect(() => {
    if (!selectedFactions.length) return
    const alive = new Set((graph?.factions ?? []).map((f) => f.faction_id))
    const next = selectedFactions.filter((id) => alive.has(id))
    if (next.length !== selectedFactions.length) setSelectedFactions(next)
  }, [graph, selectedFactions])

  // ── 选中状态（纯 UI） ──
  const [selectedEdge, setSelectedEdge] = useState<GraphEdge | null>(null)
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null)
  const [egoPersonId, setEgoPersonId] = useState<string | null>(null)
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null)

  // ── banner ──
  const [error, setError] = useState('')
  const [msg, setMsg] = useState('')

  // ── 包装 loadGraph：清选择 + 写 banner ──
  const handleLoadGraph = useCallback(async () => {
    setError('')
    setSelectedEdge(null)
    setSelectedNode(null)
    setEgoPersonId(null)
    const { error: err, msg: m } = await loadGraph()
    setError(err)
    setMsg(m)
  }, [loadGraph])

  // ── 分析 ──
  const { analysis, start: startAnalysis, stop: stopAnalysis, isRunning, pushLog } =
    useAnalysis({
      chapterLabel,
      onAnalysisDone: async () => {
        await refreshBooks()
        await handleLoadGraph()
      },
      onBanner: (err, m) => {
        setError(err)
        setMsg(m)
      },
    })

  // ── 首次加载自动选 demo 书 ──
  useEffect(() => {
    if (!bookId && books.length) {
      const demo = books.find((b) => b.book_id === 'aa317311-a246-4900-bb6a-19a2fa820669')
      setBookId(demo?.book_id ?? books[0].book_id)
    }
  }, [books, bookId])

  // ── 书切换 / 过滤变化 → 自动刷新图（分析中不打断） ──
  useEffect(() => {
    if (bookId && !isRunning) void handleLoadGraph()
  }, [bookId, handleLoadGraph, isRunning])

  // ── 事件处理 ──

  const onUpload = useCallback(
    async (file: File | null) => {
      if (!file) return
      setError('')
      setMsg('')
      try {
        const res = await uploadBook(file)
        pushLog('ok', `已上传：${res.title}`)
        await refreshBooks()
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
  }, [])

  /** 抽取势力：单次 LLM 会话，几十秒级，完成后重载图 */
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

  /**
   * 搜索命中 → 聚焦。
   *
   * 命中的人可能正被势力筛选 / ego 模式挡在图外，那就先把挡住他的视图约束撤掉，
   * 否则动画会对着一个不存在的节点空转。被 min_appearance 过滤的只能给提示——
   * 那是后端出图阶段就没给出的节点。
   */
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
      // nonce 递增，保证同一人可以反复聚焦
      setFocusRequest((prev) => ({
        personId: hit.personId,
        nonce: (prev?.nonce ?? 0) + 1,
      }))
    },
    [graph, minAppearance, selectedFactions],
  )

  const selectedBook = books.find((b) => b.book_id === bookId)

  // ── render ──
  return (
    <div className="app">
      <HeaderBar
        bookId={bookId}
        isRunning={isRunning}
        graphLoading={graphLoading}
        factionLoading={factionLoading}
        graph={graph}
        onPickPerson={onPickPerson}
        onUpload={onUpload}
        onAnalyze={onAnalyze}
        onStop={onStop}
        onRefreshGraph={() => void handleLoadGraph()}
        onExtractFactions={() => void onExtractFactions()}
      />

      <ControlPanel
        books={books}
        bookId={bookId}
        selectedBook={selectedBook}
        onBookChange={handleBookChange}
        contentChapters={contentChapters}
        toChapter={toChapter}
        singleChapterOnly={singleChapterOnly}
        onToChapterChange={setToChapter}
        onSingleChapterOnlyChange={setSingleChapterOnly}
        minAppearance={minAppearance}
        onMinAppearanceChange={setMinAppearance}
        includeSuppressed={includeSuppressed}
        onIncludeSuppressedChange={setIncludeSuppressed}
        layoutMode={layoutMode}
        onLayoutModeChange={setLayoutMode}
        factions={graph?.factions ?? []}
        selectedFactions={selectedFactions}
        onSelectedFactionsChange={setSelectedFactions}
        isRunning={isRunning}
      />

      <AnalysisProgress analysis={analysis} />

      {(error || msg) && (
        <div className={`banner ${error ? 'err' : 'ok'}`}>
          {error || msg}
        </div>
      )}

      <main className="main">
        <div className="canvas-wrap">
          {isRunning ? (
            <div className="graph-empty">
              分析进行中，完成后会自动刷新图…
              <br />
              <span className="hint">当前阶段：{analysis.phase}</span>
            </div>
          ) : graph ? (
            <GraphView
              data={graph}
              layoutMode={layoutMode}
              selectedFactions={selectedFactions}
              focusRequest={focusRequest}
              egoPersonId={egoPersonId}
              onExitEgo={() => setEgoPersonId(null)}
              onSelectEdge={setSelectedEdge}
              onSelectNode={setSelectedNode}
            />
          ) : (
            <div className="graph-empty">选择书籍并刷新图</div>
          )}
        </div>
        <DetailPanel
          graph={graph}
          selectedNode={selectedNode}
          selectedEdge={selectedEdge}
          egoPersonId={egoPersonId}
          chapterLabel={chapterLabel}
          onSetEgo={setEgoPersonId}
        />
      </main>
    </div>
  )
}