import { useCallback, useEffect, useRef, useState } from 'react'
import {
  analysisChapters,
  getGraph,
  listBooks,
  listChapters,
  startAnalysis,
  stopAnalysis,
  subscribeAnalysisProgress,
  uploadBook,
  type BookMeta,
  type ChapterBrief,
  type DoneEvent,
  type GraphData,
  type GraphEdge,
  type GraphNode,
  type ProgressEvent,
} from './api'
import { GraphView } from './GraphView'
import './App.css'

type LogLine = {
  id: number
  kind: 'info' | 'ok' | 'fail' | 'phase'
  text: string
}

type AnalysisUi = {
  running: boolean
  total: number
  done: number
  phase: string
  logs: LogLine[]
}

const emptyAnalysis = (): AnalysisUi => ({
  running: false,
  total: 0,
  done: 0,
  phase: '',
  logs: [],
})

export default function App() {
  const [books, setBooks] = useState<BookMeta[]>([])
  const [bookId, setBookId] = useState('')
  const [graph, setGraph] = useState<GraphData | null>(null)
  const [error, setError] = useState('')
  const [graphLoading, setGraphLoading] = useState(false)
  const [toChapter, setToChapter] = useState<number | ''>('')
  /** true = 仅所选章；false = 截至该章累计（或全部） */
  const [singleChapterOnly, setSingleChapterOnly] = useState(false)
  const [chapters, setChapters] = useState<ChapterBrief[]>([])
  const [minAppearance, setMinAppearance] = useState(1)
  const [includeSuppressed, setIncludeSuppressed] = useState(false)
  const [selectedEdge, setSelectedEdge] = useState<GraphEdge | null>(null)
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null)
  /** 非空时图只显示该人一度邻居（详情按钮触发） */
  const [egoPersonId, setEgoPersonId] = useState<string | null>(null)
  const [msg, setMsg] = useState('')
  const [analysis, setAnalysis] = useState<AnalysisUi>(emptyAnalysis)

  const logId = useRef(0)
  const unsubRef = useRef<(() => void) | null>(null)
  const chaptersRef = useRef<ChapterBrief[]>([])
  const selectedBook = books.find((b) => b.book_id === bookId)
  const contentChapters = analysisChapters(chapters)

  const chapterLabel = useCallback((chapterId: number | undefined) => {
    if (chapterId == null) return '?'
    const list = chaptersRef.current
    const hit = list.find((c) => c.chapter_id === chapterId)
    if (hit?.title) return hit.title
    return `第 ${chapterId} 段`
  }, [])

  const pushLog = useCallback((kind: LogLine['kind'], text: string) => {
    logId.current += 1
    const line = { id: logId.current, kind, text }
    setAnalysis((prev) => ({
      ...prev,
      logs: [...prev.logs.slice(-80), line],
    }))
  }, [])

  const refreshBooks = useCallback(async () => {
    try {
      const list = await listBooks()
      setBooks(list)
      if (!bookId && list.length) {
        const demo = list.find((b) => b.book_id === 'demo-zhiying')
        setBookId(demo?.book_id ?? list[0].book_id)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [bookId])

  useEffect(() => {
    void refreshBooks()
  }, [refreshBooks])

  useEffect(() => {
    return () => {
      unsubRef.current?.()
    }
  }, [])

  // Load chapter list when book changes; reset to_chapter if invalid
  useEffect(() => {
    if (!bookId) {
      setChapters([])
      chaptersRef.current = []
      setToChapter('')
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const list = await listChapters(bookId)
        if (cancelled) return
        setChapters(list)
        chaptersRef.current = list
        const allowed = new Set(
          analysisChapters(list).map((c) => c.chapter_id),
        )
        setToChapter((prev) =>
          prev !== '' && allowed.has(prev) ? prev : '',
        )
        setSingleChapterOnly(false)
      } catch (e) {
        if (!cancelled) {
          setChapters([])
          chaptersRef.current = []
          setError(e instanceof Error ? e.message : String(e))
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [bookId])

  const loadGraph = useCallback(async () => {
    if (!bookId) return
    setGraphLoading(true)
    setError('')
    setSelectedEdge(null)
    setSelectedNode(null)
    setEgoPersonId(null)
    try {
      if (singleChapterOnly && toChapter === '') {
        setGraph(null)
        setMsg('')
        setError('勾选「仅该章」时请先选择具体章节')
        setGraphLoading(false)
        return
      }
      const data = await getGraph(bookId, {
        to_chapter: toChapter === '' ? undefined : toChapter,
        single_chapter: singleChapterOnly,
        min_appearance: minAppearance,
        include_suppressed: includeSuppressed,
      })
      setGraph(data)
      let rangeLabel = ' · 无章数据'
      if (data.chapter_range.length >= 2) {
        const [lo, hi] = data.chapter_range
        rangeLabel =
          lo === hi
            ? ` · 仅「${chapterLabel(lo)}」`
            : ` · 截至「${chapterLabel(hi)}」（累计）`
      }
      setMsg(
        `图：${data.nodes.length} 人 · ${data.edges.length} 边` +
          rangeLabel +
          (data.filtered_count ? ` · 隐藏路人 ${data.filtered_count}` : ''),
      )
    } catch (e) {
      setGraph(null)
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setGraphLoading(false)
    }
  }, [
    bookId,
    toChapter,
    singleChapterOnly,
    minAppearance,
    includeSuppressed,
    chapterLabel,
  ])

  useEffect(() => {
    if (bookId && !analysis.running) void loadGraph()
  }, [bookId, loadGraph, analysis.running])

  async function onUpload(file: File | null) {
    if (!file) return
    setGraphLoading(true)
    setError('')
    try {
      const res = await uploadBook(file)
      setMsg(`已上传：${res.title}`)
      await refreshBooks()
      setBookId(res.book_id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setGraphLoading(false)
    }
  }

  function handleProgress(data: ProgressEvent) {
    if (data.phase === 'reconcile_running') {
      setAnalysis((prev) => ({ ...prev, phase: '总校对中…' }))
      pushLog('phase', '进入总校对（Reconcile）…')
      return
    }
    const label = chapterLabel(data.chapter_id)
    if (data.total != null || data.done != null) {
      setAnalysis((prev) => ({
        ...prev,
        total: data.total ?? prev.total,
        done: data.done ?? prev.done,
        phase:
          data.status === 'failed'
            ? `「${label}」失败`
            : data.chapter_id != null
              ? `「${label}」完成`
              : prev.phase,
      }))
    }
    if (data.chapter_id != null) {
      if (data.status === 'failed') {
        pushLog(
          'fail',
          `「${label}」失败${data.error ? `：${data.error}` : ''}`,
        )
      } else {
        pushLog(
          'ok',
          `「${label}」完成 (${data.done ?? '?'}/${data.total ?? '?'})`,
        )
      }
    }
  }

  async function handleDone(data: DoneEvent) {
    unsubRef.current = null
    const failed = data.chapters_failed ?? 0
    const done = data.chapters_done ?? 0
    const status = data.status || data.phase || 'done'

    setAnalysis((prev) => ({
      ...prev,
      running: false,
      done: data.total ? Math.min(data.total, done + failed) : prev.done,
      total: data.total ?? prev.total,
      phase:
        status === 'failed'
          ? '分析失败'
          : status === 'reconcile_failed' || data.degraded
            ? '校对降级完成'
            : '分析完成',
    }))

    if (data.error === 'no analysis running') {
      pushLog('fail', '没有进行中的分析（SSE 未挂上编排器）')
      setError('没有进行中的分析')
      return
    }

    if (data.errors?.length) {
      for (const err of data.errors) {
        pushLog('fail', `「${chapterLabel(err.chapter_id)}」：${err.error}`)
      }
    }

    if (failed > 0 || status === 'failed') {
      const summary =
        `分析结束：成功 ${done} 章 · 失败 ${failed} 章` +
        (data.stopped ? ' · 已中断' : '') +
        (status ? ` · status=${status}` : '')
      pushLog('fail', summary)
      setError(summary)
      setMsg('')
    } else if (data.degraded || data.phase === 'reconcile_failed') {
      const summary = `章分析完成（${done}），总校对失败/降级，仍可出图`
      pushLog('info', summary)
      setMsg(summary)
      setError('')
    } else {
      const summary = `分析完成：${done} 章 · 总校对 ${data.reconcile_done ? 'OK' : '跳过'}`
      pushLog('ok', summary)
      setMsg(summary)
      setError('')
    }

    await refreshBooks()
    // failed with 0 done → graph may be empty; still try
    await loadGraph()
  }

  async function onAnalyze() {
    if (!bookId) return
    unsubRef.current?.()
    unsubRef.current = null
    setError('')
    setMsg('')
    setAnalysis({
      running: true,
      total: 0,
      done: 0,
      phase: '启动中…',
      logs: [],
    })
    logId.current = 0

    try {
      const start = await startAnalysis(
        bookId,
        toChapter === '' ? undefined : toChapter,
      )
      const total = start.total_chapters ?? 0
      setAnalysis((prev) => ({
        ...prev,
        total,
        phase: total ? `并行分析 ${total} 章…` : '无待分析章节',
      }))
      const until =
        toChapter === ''
          ? '全书正文'
          : `截止「${chapterLabel(toChapter)}」`
      pushLog(
        'info',
        `已启动分析：${until}，队列 ${total} 章（mode=${start.mode ?? 'few_long'}）`,
      )

      if (total === 0) {
        setAnalysis((prev) => ({ ...prev, running: false, phase: '无章可分析' }))
        setError(
          '没有可分析的章节（仅导读/附录，或 to_chapter 未覆盖任何 include_in_analysis 正文）',
        )
        await refreshBooks()
        return
      }

      // Connect SSE immediately so queue events are not missed for long
      unsubRef.current = subscribeAnalysisProgress(bookId, {
        onProgress: handleProgress,
        onDone: (d) => {
          void handleDone(d)
        },
        onError: (m) => {
          // soft warning only while running
          pushLog('info', m)
        },
      })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      setAnalysis((prev) => ({
        ...prev,
        running: false,
        phase: '启动失败',
      }))
      pushLog('fail', message)
      setError(message)
    }
  }

  async function onStop() {
    if (!bookId) return
    try {
      await stopAnalysis(bookId)
      pushLog('info', '已请求停止（运行中的章会跑完）')
      setAnalysis((prev) => ({ ...prev, phase: '停止中…' }))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const nameOf = (pid: string) =>
    graph?.nodes.find((n) => n.person_id === pid)?.name ?? pid

  const pct =
    analysis.total > 0
      ? Math.min(100, Math.round((analysis.done / analysis.total) * 100))
      : analysis.running
        ? 5
        : 0

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <h1>ZhiYing</h1>
          <span className="sub">最小预览 · 人物关系图</span>
        </div>
        <div className="actions">
          <label className="btn file-btn">
            上传 EPUB
            <input
              type="file"
              accept=".epub"
              hidden
              onChange={(e) => void onUpload(e.target.files?.[0] ?? null)}
            />
          </label>
          <button
            type="button"
            className="btn"
            disabled={!bookId || analysis.running}
            onClick={() => void onAnalyze()}
          >
            {analysis.running ? '分析中…' : '启动分析'}
          </button>
          {analysis.running && (
            <button type="button" className="btn danger" onClick={() => void onStop()}>
              停止
            </button>
          )}
          <button
            type="button"
            className="btn primary"
            disabled={!bookId || graphLoading || analysis.running}
            onClick={() => void loadGraph()}
          >
            {graphLoading ? '加载中…' : '刷新图'}
          </button>
        </div>
      </header>

      <section className="controls">
        <label>
          书籍
          <select
            value={bookId}
            disabled={analysis.running}
            onChange={(e) => {
              setBookId(e.target.value)
              setEgoPersonId(null)
              setSelectedNode(null)
              setSelectedEdge(null)
            }}
          >
            {!books.length && <option value="">（无书）</option>}
            {books.map((b) => (
              <option key={b.book_id} value={b.book_id}>
                [{b.status}] {b.title.slice(0, 48)}
                {b.title.length > 48 ? '…' : ''}
              </option>
            ))}
          </select>
        </label>
        <label>
          截止章节
          <select
            disabled={analysis.running || !bookId}
            value={toChapter === '' ? '' : String(toChapter)}
            onChange={(e) =>
              setToChapter(e.target.value === '' ? '' : Number(e.target.value))
            }
            title="仅列出 include_in_analysis 的正文卷；导读/年表不出现"
          >
            {!singleChapterOnly && <option value="">全部正文</option>}
            {contentChapters.map((c) => (
              <option key={c.chapter_id} value={c.chapter_id}>
                {c.title || `章节 ${c.chapter_id}`}
                {c.word_count ? ` · ${c.word_count}字` : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="check">
          <input
            type="checkbox"
            disabled={analysis.running || !bookId}
            checked={singleChapterOnly}
            onChange={(e) => {
              const on = e.target.checked
              setSingleChapterOnly(on)
              if (on && toChapter === '' && contentChapters[0]) {
                setToChapter(contentChapters[0].chapter_id)
              }
            }}
          />
          仅该章
        </label>
        <label>
          min_appearance
          <input
            type="number"
            min={0}
            max={20}
            value={minAppearance}
            onChange={(e) => setMinAppearance(Number(e.target.value) || 0)}
          />
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={includeSuppressed}
            onChange={(e) => setIncludeSuppressed(e.target.checked)}
          />
          显示被压制 soft
        </label>
        {selectedBook && (
          <span className="meta">
            {selectedBook.author || '未知作者'} · {selectedBook.total_chapters} 章 ·{' '}
            {selectedBook.status}
          </span>
        )}
      </section>

      {(analysis.running || analysis.logs.length > 0) && (
        <section className={`progress-panel ${analysis.running ? 'live' : ''}`}>
          <div className="progress-head">
            <strong>{analysis.phase || (analysis.running ? '分析中' : '上次分析')}</strong>
            <span>
              {analysis.done}/{analysis.total || '—'} · {pct}%
            </span>
          </div>
          <div className="progress-track" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
            <div
              className={`progress-fill ${analysis.running ? 'anim' : ''}`}
              style={{ width: `${pct}%` }}
            />
          </div>
          <ul className="progress-log">
            {analysis.logs.map((line) => (
              <li key={line.id} className={`log-${line.kind}`}>
                {line.text}
              </li>
            ))}
          </ul>
        </section>
      )}

      {(error || msg) && (
        <div className={`banner ${error ? 'err' : 'ok'}`}>
          {error || msg}
        </div>
      )}

      <main className="main">
        <div className="canvas-wrap">
          {analysis.running ? (
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
        <aside className="side">
          <h2>详情</h2>
          {!selectedNode && !selectedEdge && (
            <p className="hint">
              点击节点或边查看详情。拖动画布 / 滚轮缩放。
              在人物详情中可「只看与此人的关系」。
            </p>
          )}
          {selectedNode && (
            <div className="card">
              <h3>{selectedNode.name}</h3>
              <dl>
                <dt>id</dt>
                <dd>{selectedNode.person_id}</dd>
                <dt>重要度</dt>
                <dd>{selectedNode.importance}</dd>
                <dt>出场章数</dt>
                <dd>{selectedNode.appearance_count}</dd>
                <dt>别名</dt>
                <dd>{selectedNode.aliases.join('、') || '—'}</dd>
                <dt>简介</dt>
                <dd>{selectedNode.bio || '—'}</dd>
              </dl>
              <div className="detail-actions">
                {egoPersonId === selectedNode.person_id ? (
                  <button
                    type="button"
                    className="btn"
                    onClick={() => setEgoPersonId(null)}
                  >
                    回到全图
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn primary"
                    onClick={() => setEgoPersonId(selectedNode.person_id)}
                  >
                    只看与此人的关系
                  </button>
                )}
              </div>
            </div>
          )}
          {selectedEdge && (
            <div className="card">
              <h3>
                {nameOf(selectedEdge.person_a)} ↔ {nameOf(selectedEdge.person_b)}
              </h3>
              {selectedEdge.tags.map((t) => (
                <div key={t.type} className={`tag tier-${t.tier}`}>
                  <div className="tag-head">
                    <strong>{t.type}</strong>
                    <span>
                      {t.tier}
                      {t.directed ? ' · 有向' : ''}
                      {t.suppressed ? ' · 已压制' : ''}
                    </span>
                  </div>
                  <div className="tag-meta">
                    分 {t.display_score.toFixed(1)} ·{' '}
                    {t.chapter_ids.map((id) => chapterLabel(id)).join('、')}
                  </div>
                  {t.evidences.length > 0 && (
                    <ul className="quotes">
                      {t.evidences.map((ev, i) => (
                        <li key={i}>
                          <span className="ch">{chapterLabel(ev.chapter_id)}</span>
                          {ev.quote || '（无原句）'}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          )}
          {graph && graph.filtered_persons.length > 0 && (
            <div className="card muted">
              <h3>隐藏路人 ({graph.filtered_count})</h3>
              <p className="hint">
                {graph.filtered_persons.map((p) => p.name).join('、')}
              </p>
            </div>
          )}
        </aside>
      </main>
    </div>
  )
}
