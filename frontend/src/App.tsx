import { useCallback, useEffect, useState } from 'react'
import { analysisChapters, uploadBook, type GraphEdge, type GraphNode } from './api'
import { GraphView } from './GraphView'
import { HeaderBar } from './components/HeaderBar'
import { ControlPanel } from './components/ControlPanel'
import { AnalysisProgress } from './components/AnalysisProgress'
import { DetailPanel } from './components/DetailPanel'
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

  // ── 选中状态（纯 UI） ──
  const [selectedEdge, setSelectedEdge] = useState<GraphEdge | null>(null)
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null)
  const [egoPersonId, setEgoPersonId] = useState<string | null>(null)

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
      const demo = books.find((b) => b.book_id === 'demo-zhiying')
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

  const selectedBook = books.find((b) => b.book_id === bookId)

  // ── render ──
  return (
    <div className="app">
      <HeaderBar
        bookId={bookId}
        isRunning={isRunning}
        graphLoading={graphLoading}
        onUpload={onUpload}
        onAnalyze={onAnalyze}
        onStop={onStop}
        onRefreshGraph={() => void handleLoadGraph()}
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