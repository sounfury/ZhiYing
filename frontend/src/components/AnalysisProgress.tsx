/**
 * 分析进度卡：按后端任务快照渲染整书分析与单章重跑的全过程。
 * - 运行中：盖在图谱区上方居中（旧图淡淡透出），显示阶段步骤条、逐章分段进度、已用时 / 请求数 / token 与停止按钮；
 * - 失败（有章失败，不发布）：保留卡片，列出失败章与原因，说明上一版结果不变，提供「只补读失败章节」；
 * - 成功 / 取消：收成右下角小提示，几秒后自动淡出，也可手动关闭。
 * 详细日志收在卡片底部的折叠区里。只负责展示，动作通过回调交给外层。
 */
import { useEffect, useMemo, useState } from 'react'
import type { AnalysisTaskChapter, AnalysisTaskSnapshot, ChapterBrief } from '../api'
import { formatTokens, formatWords, shortTitle } from '../labels'
import type { AnalysisUi } from '../types'

interface AnalysisProgressProps {
  analysis: AnalysisUi
  /** 当前书名（标题用） */
  bookTitle: string
  /** 正文章节列表（取字数） */
  chapters: ChapterBrief[]
  /** 是否已有上一版可读结果（决定失败说明的措辞） */
  hasPrevious: boolean
  onStop: () => void
  /** 只补读失败章节（整书）/ 再重跑一次（单章） */
  onRetryFailed: () => void
  onDismiss: () => void
}

/** 阶段步骤条：后端 phase → 第几步（preparing 视同读章前） */
const STEPS = ['读章', '后处理', '团体归纳', '发布']
const STEP_OF_PHASE: Record<string, number> = {
  preparing: 0,
  reading: 0,
  post_processing: 1,
  inducing_affiliations: 2,
  publishing: 3,
  finished: 4,
}
const CIRCLED = ['①', '②', '③', '④']

/** 章很多时，已完成的章默认折叠 */
const COLLAPSE_OVER = 12
/** 成功 / 取消提示自动淡出前停留时间 */
const NOTICE_TTL_MS = 8000
const FADE_MS = 400

function isSettledOk(c: AnalysisTaskChapter): boolean {
  return c.status === 'done' || c.status === 'partial'
}

/** 运行中的计时显示：02:43 / 1:02:43 */
function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const h = Math.floor(s / 3600)
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

/** 结束后的用时：3 分 26 秒 / 48 秒 */
function duration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  const m = Math.floor(s / 60)
  return m ? `${m} 分 ${s % 60} 秒` : `${s} 秒`
}

function elapsedSeconds(task: AnalysisTaskSnapshot | null, now: number): number {
  if (!task?.started_at) return 0
  const end = task.finished_at ? Date.parse(task.finished_at) : now
  return (end - Date.parse(task.started_at)) / 1000
}

/** 章卡片上的状态文字 */
function chapterState(c: AnalysisTaskChapter): { text: string; tone: '' | 'run' | 'ok' | 'err' } {
  switch (c.status) {
    case 'pending':
      return { text: '排队', tone: '' }
    case 'running':
      return {
        text: c.units_total > 1 ? `在读 第 ${Math.min(c.units_done + 1, c.units_total)}/${c.units_total} 段` : '在读',
        tone: 'run',
      }
    case 'done':
    case 'partial': {
      const base = c.reused ? '复用' : '完成'
      return { text: c.status === 'partial' ? `${base} · 有警告` : base, tone: 'ok' }
    }
    case 'failed':
      return { text: '失败', tone: 'err' }
    case 'cancelled':
      return { text: '已停止', tone: '' }
    default:
      return { text: c.status, tone: '' }
  }
}

/** 分段进度条：已读段着色、在读段闪烁、失败段标红 */
function Bars({ c }: { c: AnalysisTaskChapter }) {
  const n = Math.max(1, c.units_total)
  const ok = isSettledOk(c)
  return (
    <div className="bars" aria-hidden="true">
      {Array.from({ length: n }, (_, i) => {
        let cls = ''
        if (ok) cls = c.reused ? 'd reused' : 'd'
        else if (i < c.units_done) cls = 'd'
        else if (i === c.units_done && c.status === 'running') cls = 'r'
        else if (i === Math.min(c.units_done, n - 1) && c.status === 'failed') cls = 'f'
        return <i key={i} className={cls} />
      })}
    </div>
  )
}

function ChapterCard({ c, words }: { c: AnalysisTaskChapter; words?: number }) {
  const state = chapterState(c)
  return (
    <div className={`pc${c.status === 'failed' ? ' failed' : ''}`} title={c.last_error || undefined}>
      <b>{c.title || `第 ${c.chapter_id} 章`}</b>
      <Bars c={c} />
      <small>
        {words != null && <>{formatWords(words)} · </>}
        <span className={state.tone ? `st-${state.tone}` : undefined}>{state.text}</span>
      </small>
    </div>
  )
}

function Steps({ phase }: { phase: string }) {
  const cur = STEP_OF_PHASE[phase] ?? 0
  return (
    <ol className="steps" aria-label="分析阶段">
      {STEPS.map((name, i) => {
        const cls = i < cur ? 'done' : i === cur ? 'cur' : ''
        return (
          <li key={name} className={cls} aria-current={i === cur ? 'step' : undefined}>
            {CIRCLED[i]} {name}
          </li>
        )
      })}
    </ol>
  )
}

function Usage({ task, seconds, live }: { task: AnalysisTaskSnapshot | null; seconds: number; live: boolean }) {
  const total = task?.total_tokens ?? 0
  const tokenTitle = task
    ? `输入 ${formatTokens(task.input_tokens ?? 0)} · 输出 ${formatTokens(task.output_tokens ?? 0)}`
    : undefined
  return (
    <>
      <span>
        {live ? '已用时' : '用时'} <b>{live ? clock(seconds) : duration(seconds)}</b>
      </span>
      <span>
        请求 <b>{task?.llm_requests ?? 0}</b> 次
      </span>
      <span title={tokenTitle}>
        token <b>{formatTokens(total)}</b>
      </span>
    </>
  )
}

function LogDetails({ analysis }: { analysis: AnalysisUi }) {
  if (!analysis.logs.length) return null
  return (
    <details className="plog">
      <summary>详细日志（{analysis.logs.length}）</summary>
      <ul>
        {analysis.logs.map((line) => (
          <li key={line.id} className={`log-${line.kind}`}>
            {line.text}
          </li>
        ))}
      </ul>
    </details>
  )
}

export function AnalysisProgress({
  analysis,
  bookTitle,
  chapters,
  hasPrevious,
  onStop,
  onRetryFailed,
  onDismiss,
}: AnalysisProgressProps) {
  const { task, running } = analysis
  const [now, setNow] = useState(() => Date.now())
  const [showSettled, setShowSettled] = useState(false)
  const [leaving, setLeaving] = useState(false)

  const words = useMemo(() => new Map(chapters.map((c) => [c.chapter_id, c.word_count])), [chapters])

  // 运行中每秒刷新已用时
  useEffect(() => {
    if (!running) return
    setNow(Date.now())
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [running])

  const outcome = running ? 'running' : (task?.status ?? '')
  const isNotice = !analysis.dismissed && (outcome === 'completed' || outcome === 'cancelled')

  // 成功 / 取消提示：停留几秒后淡出（演示数据不自动消失，便于检查）
  useEffect(() => {
    setLeaving(false)
    if (!isNotice || analysis.demo) return
    const fade = window.setTimeout(() => setLeaving(true), NOTICE_TTL_MS)
    const gone = window.setTimeout(onDismiss, NOTICE_TTL_MS + FADE_MS)
    return () => {
      window.clearTimeout(fade)
      window.clearTimeout(gone)
    }
  }, [isNotice, analysis.demo, task?.task_id, onDismiss])

  if (!running && (!task || analysis.dismissed)) return null

  const isRerun = task?.kind === 'rerun'
  const rerunTitle = task?.chapters[0]?.title ?? ''
  const seconds = elapsedSeconds(task, now)
  const title = shortTitle(bookTitle)

  if (outcome === 'completed' || outcome === 'cancelled') {
    const ok = outcome === 'completed'
    const head = ok
      ? `${isRerun ? `「${rerunTitle}」重跑完成，` : ''}${task?.message || '已发布'}`
      : '已停止，上一版结果保持不变'
    return (
      <div className={`progress-notice${ok ? ' ok' : ''}${leaving ? ' leaving' : ''}`} role="status">
        <span className="dot" aria-hidden="true">
          {ok ? '✓' : '■'}
        </span>
        <span className="txt">
          {head}
          <span className="sub">
            {' '}
            · 用时 {duration(seconds)} · {formatTokens(task?.total_tokens ?? 0)} token
          </span>
        </span>
        <button type="button" className="btn ghost" onClick={onDismiss} aria-label="关闭提示">
          ✕
        </button>
      </div>
    )
  }

  if (outcome === 'failed') {
    const failed = task?.chapters.filter((c) => c.status === 'failed') ?? []
    const heading = isRerun
      ? `重跑「${rerunTitle}」失败`
      : failed.length
        ? `分析未完成：${failed.length} 章读取失败`
        : '分析未完成'
    const okCount = task?.chapters.filter(isSettledOk).length ?? 0
    return (
      <section className="progress-card result failed" aria-label="分析结果">
        <h2>{heading}</h2>
        <p className="pnote">
          {hasPrevious ? '本次未发布，上一版结果保持不变。' : '本次未发布，暂无可用结果。'}
          {!isRerun && failed.length > 0 && okCount > 0 && `已读成功的 ${okCount} 章已保存，补读时直接沿用，不会重复消耗。`}
        </p>
        {failed.length > 0 ? (
          <ul className="pfail">
            {failed.map((c) => (
              <li key={c.chapter_id}>
                <b>{c.title || `第 ${c.chapter_id} 章`}</b>
                <span>{c.last_error || '未知原因'}</span>
              </li>
            ))}
          </ul>
        ) : (
          task?.message && <p className="pfail-msg">{task.message}</p>
        )}
        <div className="pmeta">
          <Usage task={task} seconds={seconds} live={false} />
        </div>
        <div className="pactions">
          <button type="button" className="btn primary" onClick={onRetryFailed}>
            {isRerun ? '再重跑一次' : failed.length ? '只补读失败章节' : '重新分析'}
          </button>
          <button type="button" className="btn ghost" onClick={onDismiss}>
            收起
          </button>
        </div>
        <LogDetails analysis={analysis} />
      </section>
    )
  }

  // 运行中
  const list = task?.chapters ?? []
  const collapsible = !isRerun && list.length > COLLAPSE_OVER
  const settled = list.filter(isSettledOk)
  const visible = collapsible && !showSettled ? list.filter((c) => !isSettledOk(c)) : list
  const phase = task?.phase ?? 'preparing'

  return (
    <div className="progress-scrim">
      <section className="progress-card" aria-label="分析进度" aria-live="polite">
        <h2>{isRerun ? `正在重跑「${rerunTitle}」` : title ? `正在分析《${title}》` : '正在分析'}</h2>
        <Steps phase={phase} />
        {collapsible && (
          <button type="button" className="text-link pfold" onClick={() => setShowSettled((v) => !v)}>
            {showSettled ? '收起已完成的章' : `已完成 ${settled.length} 章 · 展开`}
          </button>
        )}
        {task ? (
          <div className={`pgrid${isRerun ? ' single' : ''}`}>
            {visible.map((c) => (
              <ChapterCard key={c.chapter_id} c={c} words={words.get(c.chapter_id)} />
            ))}
          </div>
        ) : (
          <p className="pnote">正在创建任务…</p>
        )}
        <div className="pmeta">
          <Usage task={task} seconds={seconds} live />
        </div>
        {phase === 'post_processing' && (
          <p className="phint">后处理：身份消歧 → 类型归一 → 补查 → 兜底 → 全书简介</p>
        )}
        <div className="pactions">
          <button type="button" className="btn" onClick={onStop} disabled={analysis.stopping || !task}>
            {analysis.stopping ? '正在停止…' : '停止'}
          </button>
          {analysis.stopping && <span className="hint">进行中的模型请求返回后结束，本次不发布</span>}
        </div>
        <LogDetails analysis={analysis} />
      </section>
    </div>
  )
}
