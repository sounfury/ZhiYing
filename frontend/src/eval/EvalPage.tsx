/**
 * 评测页（/eval，DESIGN §7、PRD §8）：顶栏选评测集与运行记录、发起评测；下方左栏选总览或某一章，右栏看详情。
 * 页面只负责编排：发起准备 → 订阅分析进度 → 完成后评分 → 刷新运行列表；报告展示在 ReportView。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { getAnalysisTask, getRelationTypes, subscribeAnalysisProgress, type ProgressEvent } from '../api'
import { getRun, listRuns, listSuites, prepareSuite, scoreSuite, type EvalRun, type EvalRunSummary, type EvalSuite } from './evalApi'
import { ReportView, type Pane } from './ReportView'
import { formatDuration, formatTime, formatTokens } from './format'
import './eval.css'

const PHASE_LABEL: Record<string, string> = {
  preparing: '准备中',
  reading: '读章',
  post_processing: '后处理',
  inducing_affiliations: '团体归纳',
  publishing: '发布',
  finished: '已结束',
}

type Progress = { phase: string; done: number; total: number; tokens: number }

export default function EvalPage() {
  const [suites, setSuites] = useState<EvalSuite[]>([])
  const [suiteName, setSuiteName] = useState<string | null>(null)
  const [runs, setRuns] = useState<EvalRunSummary[]>([])
  const [runId, setRunId] = useState<string | null>(null)
  const [run, setRun] = useState<EvalRun | null>(null)
  const [previous, setPrevious] = useState<EvalRun | null>(null)
  const [typeNames, setTypeNames] = useState<Map<string, string>>(new Map())
  const [pane, setPane] = useState<Pane>('overview')
  const [progress, setProgress] = useState<Progress | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const closeProgress = useRef<(() => void) | null>(null)

  const suite = suites.find((s) => s.name === suiteName) ?? null

  const refreshSuites = useCallback(async () => {
    const list = await listSuites()
    setSuites(list)
    setSuiteName((cur) => cur ?? list[0]?.name ?? null)
    return list
  }, [])

  const refreshRuns = useCallback(async (name: string, select?: string) => {
    const list = await listRuns(name)
    setRuns(list)
    setRunId(select ?? list[0]?.id ?? null)
  }, [])

  const score = useCallback(
    async (name: string) => {
      setBusy('正在评分…')
      try {
        const created = await scoreSuite(name)
        await refreshRuns(name, created.id)
        await refreshSuites()
      } finally {
        setBusy(null)
      }
    },
    [refreshRuns, refreshSuites],
  )

  /** 订阅评测书的分析进度；发布了新结果就自动评分。 */
  const follow = useCallback(
    (name: string, bookId: string, total: number) => {
      closeProgress.current?.()
      setProgress({ phase: 'preparing', done: 0, total, tokens: 0 })
      closeProgress.current = subscribeAnalysisProgress(bookId, {
        onProgress: (e: ProgressEvent) =>
          setProgress((p) => ({
            phase: e.phase ?? p?.phase ?? '',
            done: e.done ?? p?.done ?? 0,
            total: e.total ?? p?.total ?? total,
            tokens: e.total_tokens ?? p?.tokens ?? 0,
          })),
        onDone: (d) => {
          setProgress(null)
          closeProgress.current = null
          if (d.published) void score(name).catch((e) => setError(String(e.message ?? e)))
          else setError(`分析未发布新结果：${d.message ?? d.status}`)
        },
        onError: (m) => setError(m),
      })
    },
    [score],
  )

  useEffect(() => {
    refreshSuites().catch((e) => setError(e.message))
    return () => closeProgress.current?.()
  }, [refreshSuites])

  // 换评测集：载入运行列表；评测书正在分析（例如刷新了页面）就接上进度
  useEffect(() => {
    if (!suite) return
    refreshRuns(suite.name).catch((e) => setError(e.message))
    if (!suite.book_id) return
    let cancelled = false
    getAnalysisTask(suite.book_id)
      .then((t) => {
        if (!cancelled && t.active) follow(suite.name, suite.book_id!, t.total_chapters ?? t.chapters.length)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
    // 只在评测集或其书变化时执行
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suite?.name, suite?.book_id])

  // 选中运行：载入报告、上一次运行（算差值）与类型名
  useEffect(() => {
    if (!suiteName || !runId) {
      setRun(null)
      setPrevious(null)
      return
    }
    let cancelled = false
    const index = runs.findIndex((r) => r.id === runId)
    const prevId = index >= 0 ? runs[index + 1]?.id : undefined
    Promise.all([getRun(suiteName, runId), prevId ? getRun(suiteName, prevId) : Promise.resolve(null)])
      .then(([r, p]) => {
        if (cancelled) return
        setRun(r)
        setPrevious(p)
        getRelationTypes(r.book_id)
          .then((types) => !cancelled && setTypeNames(new Map(types.map((t) => [t.predicate, t.label]))))
          .catch(() => {})
      })
      .catch((e) => !cancelled && setError(e.message))
    return () => {
      cancelled = true
    }
  }, [suiteName, runId, runs])

  const onReanalyze = async () => {
    if (!suite) return
    const ok = window.confirm(`将清空《${suite.book}》现有的分析结果并整书重跑（会调用模型、产生费用），完成后自动评分。继续？`)
    if (!ok) return
    setError(null)
    setBusy('正在准备…')
    try {
      const prepared = await prepareSuite(suite.name)
      await refreshSuites()
      follow(suite.name, prepared.book_id, prepared.total_chapters)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const onScoreNow = () => {
    if (!suite) return
    setError(null)
    score(suite.name).catch((e) => setError(e.message))
  }

  const locked = progress !== null || !!busy

  return (
    <div className="ev">
      <header className="ev-top">
        <h1>评测</h1>
        <label className="ev-field">
          <span>评测集</span>
          <select value={suiteName ?? ''} onChange={(e) => setSuiteName(e.target.value)} disabled={suites.length === 0}>
            {suites.length === 0 && <option value="">（没有评测集）</option>}
            {suites.map((s) => (
              <option key={s.name} value={s.name}>
                {s.book ?? s.name}
                {s.chapter_count ? `（${s.chapter_count} 章）` : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="ev-field">
          <span>运行记录</span>
          <select value={runId ?? ''} onChange={(e) => setRunId(e.target.value)} disabled={runs.length === 0}>
            {runs.length === 0 && <option value="">（还没有运行记录）</option>}
            {runs.map((r, i) => (
              <option key={r.id} value={r.id}>
                {runLabel(r, runs[i + 1])}
              </option>
            ))}
          </select>
        </label>
        <div className="ev-top-actions">
          {suite && !suite.error && (
            <>
              <button type="button" className="btn primary" disabled={locked} onClick={() => void onReanalyze()}>
                重新分析并评测
              </button>
              <button
                type="button"
                className="btn"
                disabled={locked || !suite.book_id}
                title="不调用模型，直接给该书当前的分析结果评分"
                onClick={onScoreNow}
              >
                评测当前结果
              </button>
            </>
          )}
          <a className="btn ghost" href="/">
            ← 返回图谱
          </a>
        </div>
      </header>

      {(progress || busy || error || suite?.error) && (
        <div className="ev-status">
          {suite?.error && <div className="ev-banner">评测集读取失败：{suite.error}</div>}
          {busy && !progress && <div className="hint">{busy}</div>}
          {progress && (
            <div className="ev-progress">
              <span>
                正在分析：{PHASE_LABEL[progress.phase] ?? progress.phase} · {progress.done}/{progress.total} 章
              </span>
              <div className="bar">
                <i style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} />
              </div>
              <span className="hint">已用 {formatTokens(progress.tokens)} token，完成后自动评分</span>
            </div>
          )}
          {error && (
            <div className="ev-banner">
              {error}
              <button type="button" className="btn ghost" onClick={() => setError(null)} aria-label="关闭">
                ✕
              </button>
            </div>
          )}
        </div>
      )}

      {run ? (
        <ReportView run={run} previous={previous} typeNames={typeNames} pane={pane} onPane={setPane} />
      ) : (
        <p className="hint ev-empty">{suite ? '还没有运行记录：点「重新分析并评测」跑一次，或对已有结果「评测当前结果」。' : ''}</p>
      )}
    </div>
  )
}

/** 运行记录下拉项：分数、较上次差值、时间、用量。 */
function runLabel(r: EvalRunSummary, older?: EvalRunSummary) {
  const delta = older ? r.score - older.score : 0
  const parts = [`${r.score.toFixed(1)} 分${Math.abs(delta) >= 0.05 ? `（${delta > 0 ? '+' : ''}${delta.toFixed(1)}）` : ''}`, formatTime(r.created_at)]
  if (r.task_kind === 'RERUN') parts.push('单章重跑后')
  if (r.total_tokens != null) parts.push(`${formatTokens(r.total_tokens)} token`)
  if (r.duration_seconds != null) parts.push(formatDuration(r.duration_seconds))
  return parts.join(' · ')
}
