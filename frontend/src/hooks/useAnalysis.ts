/**
 * 分析任务的前端编排：启动整书分析 / 单章重跑 / 停止，页面刷新或切书后按后端任务快照恢复；
 * 订阅 SSE 进度并把事件合并进任务快照（AnalysisProgress 只按快照渲染），阶段切换与任务结束时重取快照校准；
 * 任务结束后回调外层刷新书目、图与侧栏。失败与取消都不发布（PRD §5.9），这里只如实展示后端终态。
 *
 * 连接约束：同一时刻只保留一条 SSE。每次启动 / 恢复 / 切书都递增代号并先关旧连接，旧代号的回调与异步结果一律丢弃；
 * 卸载时关闭连接。开发模式下 URL 带 ?mockProgress=… 时改用内置假快照（analysisMock.ts），不发任何分析请求。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  getAnalysisTask,
  startAnalysis as startAnalysisApi,
  startRerun as startRerunApi,
  stopAnalysis as stopAnalysisApi,
  subscribeAnalysisProgress,
  type AnalysisTaskSnapshot,
  type DoneEvent,
  type ProgressEvent,
} from '../api'
import { formatTokens } from '../labels'
import { emptyAnalysis, type AnalysisUi, type LogLine } from '../types'
import { mockAnalysis, readMockKind } from './analysisMock'

interface UseAnalysisParams {
  /** 章节标题查找（稳定 useCallback） */
  chapterLabel: (id: number | undefined) => string
  /** 任务结束后回调（刷新书目、图、人名册、章节结果） */
  onAnalysisDone: () => Promise<void>
  /** 写页面提示条（error + msg 同时设） */
  onBanner: (error: string, msg: string) => void
}

const PHASE_LABEL: Record<string, string> = {
  preparing: '准备中',
  reading: '读章中',
  post_processing: '后处理中',
  inducing_affiliations: '团体归纳中',
  publishing: '发布中',
  finished: '已结束',
}

/** 图谱空态等处显示的一句话阶段说明 */
function phaseText(task: AnalysisTaskSnapshot | null): string {
  if (!task) return '启动中…'
  const label = PHASE_LABEL[task.phase] ?? task.phase
  const total = task.total_chapters ?? task.chapters.length
  return task.phase === 'reading' ? `${label} · ${task.success_count ?? 0}/${total} 章` : label
}

/** 把一条 progress 事件合并进快照；事件里没有的字段保持原值 */
function mergeProgress(task: AnalysisTaskSnapshot, e: ProgressEvent): AnalysisTaskSnapshot {
  const chapters =
    e.chapter_id == null
      ? task.chapters
      : task.chapters.map((c) =>
          c.chapter_id !== e.chapter_id
            ? c
            : {
                ...c,
                status: e.status ?? c.status,
                units_done: e.units_done ?? c.units_done,
                units_total: e.units_total ?? c.units_total,
                last_error: e.error ?? (e.status === 'failed' ? c.last_error : ''),
              },
        )
  return {
    ...task,
    phase: e.phase ?? task.phase,
    chapters,
    success_count: e.success_count ?? task.success_count,
    failure_count: e.failure_count ?? task.failure_count,
    running_count: e.running_count ?? task.running_count,
    queued_count: e.queued_count ?? task.queued_count,
    llm_requests: e.llm_requests ?? task.llm_requests,
    input_tokens: e.input_tokens ?? task.input_tokens,
    output_tokens: e.output_tokens ?? task.output_tokens,
    total_tokens: e.total_tokens ?? task.total_tokens,
  }
}

/** 快照取不到时，用 done 事件补出终态 */
function finalizeFromDone(task: AnalysisTaskSnapshot | null, d: DoneEvent): AnalysisTaskSnapshot | null {
  if (!task) return null
  const failedErrors = new Map((d.errors ?? []).map((x) => [x.chapter_id, x.error]))
  return {
    ...task,
    active: false,
    status: d.status === 'analyzed' ? 'completed' : d.status,
    phase: d.phase ?? task.phase,
    finished_at: new Date().toISOString(),
    message: d.message ?? task.message,
    chapters: task.chapters.map((c) =>
      failedErrors.has(c.chapter_id) ? { ...c, status: 'failed', last_error: failedErrors.get(c.chapter_id) ?? '' } : c,
    ),
    llm_requests: d.llm_requests ?? task.llm_requests,
    total_tokens: d.total_tokens ?? task.total_tokens,
    input_tokens: d.input_tokens ?? task.input_tokens,
    output_tokens: d.output_tokens ?? task.output_tokens,
  }
}

/** 开发模式假数据（模块加载时读一次 URL） */
const MOCK_KIND = readMockKind()
/** 假数据延后出现，先让旧图加载出来，模拟「已有旧版本时启动分析」 */
const MOCK_DELAY_MS = 2000
const MAX_LOGS = 120

export function useAnalysis({ chapterLabel, onAnalysisDone, onBanner }: UseAnalysisParams) {
  const [analysis, setAnalysis] = useState<AnalysisUi>(emptyAnalysis)

  const logId = useRef(0)
  /** 当前 SSE 的关闭函数 */
  const unsubRef = useRef<(() => void) | null>(null)
  /** 连接代号：启动 / 恢复 / 切书时递增，旧代号的回调与异步结果丢弃 */
  const genRef = useRef(0)
  /** 正在跟踪的书与是否有运行中的任务（避免恢复打断正在启动的流程） */
  const bookRef = useRef('')
  const runningRef = useRef(false)
  /** 最近一条事件的阶段，用于检测阶段切换 */
  const phaseRef = useRef('')
  /** 单章重跑等待结束的回调 */
  const waiterRef = useRef<((ok: boolean) => void) | null>(null)

  /** 最新快照的镜像，供事件回调同步读取 */
  const taskRef = useRef<AnalysisTaskSnapshot | null>(null)
  useEffect(() => {
    taskRef.current = analysis.task
  }, [analysis.task])

  const onDoneRef = useRef(onAnalysisDone)
  onDoneRef.current = onAnalysisDone
  const onBannerRef = useRef(onBanner)
  onBannerRef.current = onBanner
  const chapterLabelRef = useRef(chapterLabel)
  chapterLabelRef.current = chapterLabel

  const pushLog = useCallback((kind: LogLine['kind'], text: string) => {
    logId.current += 1
    const line = { id: logId.current, kind, text }
    setAnalysis((prev) => ({ ...prev, logs: [...prev.logs.slice(-MAX_LOGS), line] }))
  }, [])

  const closeStream = useCallback(() => {
    unsubRef.current?.()
    unsubRef.current = null
  }, [])

  const settleWaiter = useCallback((ok: boolean) => {
    const w = waiterRef.current
    waiterRef.current = null
    w?.(ok)
  }, [])

  /** 重取快照写回（仅当代号未变） */
  const refreshSnapshot = useCallback(async (bookId: string, gen: number) => {
    try {
      const snap = await getAnalysisTask(bookId)
      // 任务已结束后才返回的旧快照不要覆盖终态
      if (gen !== genRef.current || !snap.task_id || (snap.active && !runningRef.current)) return
      setAnalysis((prev) => ({ ...prev, task: snap, phase: phaseText(snap) }))
    } catch {
      /* 快照失败不影响 SSE 继续推送 */
    }
  }, [])

  const handleProgress = useCallback(
    (bookId: string, gen: number, e: ProgressEvent) => {
      const task = taskRef.current
      const unknownChapter = !task || (e.chapter_id != null && !task.chapters.some((c) => c.chapter_id === e.chapter_id))
      setAnalysis((prev) => {
        if (!prev.task) return prev
        const merged = mergeProgress(prev.task, e)
        return { ...prev, task: merged, phase: phaseText(merged) }
      })
      // 阶段切换（或快照缺失 / 缺这一章）时重取快照：补齐章名、复用标记等事件里没有的字段
      const phaseChanged = e.phase != null && e.phase !== phaseRef.current
      if (phaseChanged) {
        phaseRef.current = e.phase!
        if (e.phase !== 'reading' && e.phase !== 'preparing') pushLog('phase', `进入${PHASE_LABEL[e.phase!] ?? e.phase}`)
      }
      if (phaseChanged || unknownChapter) void refreshSnapshot(bookId, gen)

      if (e.chapter_id == null) return
      const label = `「${chapterLabelRef.current(e.chapter_id)}」`
      if (e.status === 'failed') pushLog('fail', `${label}失败${e.error ? `：${e.error}` : ''}`)
      else if (e.status === 'partial') pushLog('info', `${label}完成，但有警告`)
      else if (e.status === 'done') pushLog('ok', `${label}完成`)
      else if (e.status === 'running' && (e.units_total ?? 0) > 1 && (e.units_done ?? 0) > 0) {
        pushLog('info', `${label}已读 ${e.units_done}/${e.units_total} 段`)
      }
    },
    [pushLog, refreshSnapshot],
  )

  const handleDone = useCallback(
    async (bookId: string, gen: number, d: DoneEvent) => {
      unsubRef.current = null // 订阅方收到 done 后已自行关闭
      let snap: AnalysisTaskSnapshot | null = null
      try {
        snap = await getAnalysisTask(bookId)
      } catch {
        /* 用 done 事件补终态 */
      }
      if (gen !== genRef.current) return
      runningRef.current = false

      if (d.status === 'idle' && !snap?.task_id) {
        setAnalysis((prev) => ({ ...prev, running: false, stopping: false, phase: '' }))
        settleWaiter(false)
        return
      }
      const finalSnap = snap?.task_id && !snap.active ? snap : null
      setAnalysis((prev) => ({
        ...prev,
        running: false,
        stopping: false,
        dismissed: false,
        phase: '',
        task: finalSnap ?? finalizeFromDone(prev.task, d),
      }))

      const usage = d.total_tokens != null ? ` · ${formatTokens(d.total_tokens)} token` : ''
      if (d.status === 'analyzed') pushLog('ok', `${d.message || '已发布'}${usage}`)
      else if (d.stopped || d.status === 'cancelled') pushLog('info', `已停止，上一版结果保持不变${usage}`)
      else pushLog('fail', `${d.message || '分析未完成'}${usage}`)

      settleWaiter(d.status === 'analyzed')
      await onDoneRef.current()
    },
    [pushLog, settleWaiter],
  )

  /** 打开 SSE（先关旧连接），回调只在代号未变时生效 */
  const connect = useCallback(
    (bookId: string, gen: number) => {
      closeStream()
      unsubRef.current = subscribeAnalysisProgress(bookId, {
        onProgress: (e) => {
          if (gen === genRef.current) handleProgress(bookId, gen, e)
        },
        onDone: (d) => {
          if (gen === genRef.current) void handleDone(bookId, gen, d)
        },
        onError: (m) => {
          if (gen === genRef.current) pushLog('info', m)
        },
      })
    },
    [closeStream, handleDone, handleProgress, pushLog],
  )

  /** 开始跟踪一个新任务：关旧连接、递增代号、清空进度卡 */
  const begin = useCallback(
    (bookId: string, firstLog: string) => {
      closeStream()
      settleWaiter(false)
      genRef.current += 1
      bookRef.current = bookId
      runningRef.current = true
      phaseRef.current = ''
      logId.current = 1
      setAnalysis({
        ...emptyAnalysis(),
        running: true,
        phase: '启动中…',
        logs: [{ id: 1, kind: 'info', text: firstLog }],
      })
      return genRef.current
    },
    [closeStream, settleWaiter],
  )

  /** 启动失败：收起运行态并提示 */
  const failStart = useCallback(
    (gen: number, message: string) => {
      if (gen !== genRef.current) return
      runningRef.current = false
      setAnalysis((prev) => ({ ...prev, running: false, task: null, phase: '' }))
      pushLog('fail', message)
      onBannerRef.current(message, '')
    },
    [pushLog],
  )

  /**
   * 恢复：取任务快照，运行中则接上 SSE（已在跟踪同一本书时不重复订阅）；
   * 最近一次是失败的任务则展示失败结果（告知失败章与原因）。返回是否有运行中的任务。
   */
  const resume = useCallback(
    async (bookId: string): Promise<boolean> => {
      if (!bookId || MOCK_KIND) return false
      if (bookRef.current === bookId && runningRef.current) return true
      const gen = ++genRef.current
      bookRef.current = bookId
      try {
        const snap = await getAnalysisTask(bookId)
        if (gen !== genRef.current) return false
        if (snap.active) {
          runningRef.current = true
          phaseRef.current = snap.phase
          setAnalysis((prev) => ({
            ...emptyAnalysis(),
            running: true,
            task: snap,
            phase: phaseText(snap),
            logs: prev.task?.task_id === snap.task_id ? prev.logs : [],
          }))
          connect(bookId, gen)
          return true
        }
        if (snap.status === 'failed' && snap.task_id) {
          // 同一个任务已在展示（例如刚结束后外层刷新触发）时保持现状，不覆盖用户的收起操作
          setAnalysis((prev) => (prev.task?.task_id === snap.task_id ? prev : { ...emptyAnalysis(), task: snap }))
        }
        return false
      } catch (e) {
        if (gen === genRef.current) pushLog('fail', e instanceof Error ? e.message : String(e))
        return false
      }
    },
    [connect, pushLog],
  )

  /** 启动整书分析；force=false 时沿用仍有效的章节结果（对失败的分析再次启动即只补读失败章） */
  const start = useCallback(
    async (bookId: string, toChapter: number | '', force = false): Promise<boolean> => {
      if (MOCK_KIND) {
        pushLog('info', '演示模式（?mockProgress）下不会真的启动分析')
        return false
      }
      const until = toChapter === '' ? '全书正文' : `截至「${chapterLabelRef.current(toChapter)}」`
      const gen = begin(bookId, `启动${force ? '全部重读' : '分析'}：${until}`)
      try {
        const res = await startAnalysisApi(bookId, toChapter === '' ? undefined : toChapter, force)
        if (gen !== genRef.current) return false
        if (!res.total_chapters) {
          failStart(gen, '没有可分析的章节（仅导读 / 附录，或截止章之前没有正文）')
          return false
        }
        pushLog('info', `任务已创建，共 ${res.total_chapters} 章`)
        await refreshSnapshot(bookId, gen)
        if (gen !== genRef.current) return false
        connect(bookId, gen)
        return true
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        if (message.startsWith('409:')) {
          // 已有任务在运行：直接接上它
          runningRef.current = false
          return resume(bookId)
        }
        failStart(gen, message)
        return false
      }
    },
    [begin, connect, failStart, pushLog, refreshSnapshot, resume],
  )

  /** 单章重跑：与整书分析共用进度卡与 SSE；返回的 Promise 在任务结束（并刷新完数据）后兑现，true 表示已发布 */
  const rerun = useCallback(
    async (bookId: string, chapterId: number): Promise<boolean> => {
      if (MOCK_KIND) {
        pushLog('info', '演示模式（?mockProgress）下不会真的重跑')
        return false
      }
      const gen = begin(bookId, `重跑「${chapterLabelRef.current(chapterId)}」`)
      try {
        await startRerunApi(bookId, chapterId)
        if (gen !== genRef.current) return false
        const finished = new Promise<boolean>((resolve) => {
          waiterRef.current = resolve
        })
        await refreshSnapshot(bookId, gen)
        if (gen !== genRef.current) return false
        connect(bookId, gen)
        return await finished
      } catch (e) {
        failStart(gen, e instanceof Error ? e.message : String(e))
        return false
      }
    },
    [begin, connect, failStart, pushLog, refreshSnapshot],
  )

  /** 请求停止：不再调度新的阅读单元，已发出的模型请求返回后结束，不发布 */
  const stop = useCallback(
    async (bookId: string) => {
      if (MOCK_KIND) {
        setAnalysis((prev) => ({ ...prev, stopping: true }))
        return
      }
      try {
        const res = await stopAnalysisApi(bookId)
        if (res.status === 'idle') {
          pushLog('info', '后端没有运行中的任务')
          return
        }
        setAnalysis((prev) => ({ ...prev, stopping: true }))
        pushLog('info', '已请求停止：不再启动新的阅读单元，进行中的模型请求返回后结束，本次不发布')
      } catch (e) {
        pushLog('fail', e instanceof Error ? e.message : String(e))
      }
    },
    [pushLog],
  )

  /** 收起结束提示 */
  const dismiss = useCallback(() => {
    setAnalysis((prev) => ({ ...prev, dismissed: true }))
  }, [])

  /** 切书：关连接、作废进行中的异步结果、清空进度卡 */
  const disconnect = useCallback(() => {
    closeStream()
    settleWaiter(false)
    genRef.current += 1
    bookRef.current = ''
    runningRef.current = false
    phaseRef.current = ''
    logId.current = 0
    setAnalysis(emptyAnalysis())
  }, [closeStream, settleWaiter])

  // 开发模式假数据
  useEffect(() => {
    if (!MOCK_KIND) return
    const t = window.setTimeout(() => setAnalysis(mockAnalysis(MOCK_KIND)), MOCK_DELAY_MS)
    return () => window.clearTimeout(t)
  }, [])

  // 卸载时关闭 SSE 并作废进行中的异步结果
  useEffect(
    () => () => {
      unsubRef.current?.()
      unsubRef.current = null
      genRef.current += 1
    },
    [],
  )

  return {
    analysis,
    start,
    rerun,
    stop,
    resume,
    dismiss,
    disconnect,
    isRunning: analysis.running,
    pushLog,
  }
}
