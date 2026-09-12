import { useCallback, useEffect, useRef, useState } from 'react'
import {
  startAnalysis as startAnalysisApi,
  stopAnalysis as stopAnalysisApi,
  getAnalysisTask,
  retryFailedChapters as retryFailedChaptersApi,
  skipFailedChapters as skipFailedChaptersApi,
  subscribeAnalysisProgress,
  type DoneEvent,
  type ProgressEvent,
} from '../api'
import { emptyAnalysis, type AnalysisUi, type LogLine } from '../types'

interface UseAnalysisParams {
  /** 章节标题查找（稳定 useCallback） */
  chapterLabel: (id: number | undefined) => string
  /** 分析完成后回调（App.tsx 用来 refreshBooks + loadGraph） */
  onAnalysisDone: () => Promise<void>
  /** 写 banner（error + msg 同时设） */
  onBanner: (error: string, msg: string) => void
}

/**
 * 分析流程管理：启动 / 停止 / SSE 进度 / 日志。
 *
 * start / stop 接受 bookId 参数（而非从 hook 内部读），保持纯函数式。
 * 通过 ref 持有 onAnalysisDone / onBanner / chapterLabel，避免闭包过期。
 */
export function useAnalysis({
  chapterLabel,
  onAnalysisDone,
  onBanner,
}: UseAnalysisParams) {
  const [analysis, setAnalysis] = useState<AnalysisUi>(emptyAnalysis())
  const logId = useRef(0)
  const unsubRef = useRef<(() => void) | null>(null)
  const subscribedBookRef = useRef('')

  // ref 持有外部回调，避免 useCallback 依赖链频繁变化
  const onDoneRef = useRef(onAnalysisDone)
  onDoneRef.current = onAnalysisDone
  const onBannerRef = useRef(onBanner)
  onBannerRef.current = onBanner
  const chapterLabelRef = useRef(chapterLabel)
  chapterLabelRef.current = chapterLabel

  const pushLog = useCallback((kind: LogLine['kind'], text: string) => {
    logId.current += 1
    const line = { id: logId.current, kind, text }
    setAnalysis((prev) => ({
      ...prev,
      logs: [...prev.logs.slice(-80), line],
    }))
  }, [])

  const handleProgress = useCallback(
    (data: ProgressEvent) => {
      if (
        data.success_count != null || data.failure_count != null ||
        data.running_count != null || data.queued_count != null
      ) {
        setAnalysis((prev) => ({
          ...prev,
          successCount: data.success_count ?? prev.successCount,
          failureCount: data.failure_count ?? prev.failureCount,
          runningCount: data.running_count ?? prev.runningCount,
          queuedCount: data.queued_count ?? prev.queuedCount,
        }))
      }
      if (data.kind === 'llm_request_start') {
        const phaseName = data.phase === 'chapter' ? '章节抽取' : data.phase === 'reconcile' ? '总校对' : data.phase === 'faction' ? '势力归纳' : '关系后处理'
        setAnalysis((prev) => ({ ...prev, phase: `${phaseName} · 等待模型…` }))
        return
      }
      if (data.kind === 'llm_request_heartbeat') {
        const seconds = Math.max(0, Math.round((data.elapsed_ms ?? 0) / 1000))
        setAnalysis((prev) => ({
          ...prev,
          phase: `${prev.phase.split(' · ')[0] || '模型调用'} · 等待模型 ${seconds}s${data.stop_requested ? '（已请求停止，等待已发请求返回）' : ''}`,
        }))
        return
      }
      if (data.kind === 'llm_request_end') {
        const phaseName = data.phase === 'chapter' ? '章节抽取' : data.phase === 'reconcile' ? '总校对' : data.phase === 'faction' ? '势力归纳' : '关系后处理'
        const seconds = ((data.elapsed_ms ?? 0) / 1000).toFixed(1)
        setAnalysis((prev) => ({
          ...prev,
          phase: `${phaseName} · 模型返回 ${seconds}s · 请求 ${data.llm_requests ?? '?'} · tokens ${data.total_tokens ?? '?'}`,
        }))
        pushLog('info', `${phaseName}模型请求完成：${seconds}s · 累计请求 ${data.llm_requests ?? '?'} · tokens ${data.total_tokens ?? '?'}`)
        return
      }
      if (data.kind === 'llm_request_error') {
        const seconds = ((data.elapsed_ms ?? 0) / 1000).toFixed(1)
        pushLog('info', `模型请求异常（第 ${data.attempt ?? '?'} 次，${seconds}s）：${data.error ?? '未知错误'}`)
        return
      }
      if (data.kind === 'llm_retry_wait') {
        const delay = data.delay_seconds ?? 0
        setAnalysis((prev) => ({ ...prev, phase: `模型请求重试等待 ${delay}s…` }))
        pushLog('info', `模型请求将在 ${delay}s 后进行第 ${data.attempt ?? '?'} 次尝试`)
        return
      }
      if (data.kind === 'llm_budget_stop') {
        pushLog('fail', `模型调用已停止：${data.reason ?? data.error ?? '达到预算或服务商额度限制'}`)
        return
      }
      if (data.phase === 'reconcile_tools') {
        setAnalysis((prev) => ({ ...prev, phase: `总校对 · 工具步骤 ${data.step ?? '?'}/${data.max_steps ?? '?'}` }))
        if (data.tools?.length) pushLog('info', `总校对工具：${data.tools.join('、')}`)
        return
      }
      if (data.phase === 'relations_running') {
        setAnalysis((prev) => ({ ...prev, phase: '关系归一化与验证中…' }))
        pushLog('phase', '开始归一化关系语义并核查证据…')
        return
      }
      if (data.phase === 'relation_normalize') {
        const label = chapterLabelRef.current(data.chapter_id)
        const processed = data.processed ?? 0
        const total = data.total ?? 0
        const batch = data.batch != null && data.batches != null
          ? ` · 批次 ${data.batch}/${data.batches}`
          : ''
        setAnalysis((prev) => ({
          ...prev,
          phase: `${label} · 关系归一化 ${processed}/${total}${batch}`,
        }))
        return
      }
      if (data.phase === 'relation_verify') {
        const label = chapterLabelRef.current(data.chapter_id)
        setAnalysis((prev) => ({
          ...prev,
          phase: `${label} · 证据验证 ${data.processed ?? 0}/${data.total ?? 0}`,
        }))
        return
      }
      if (data.phase === 'relations_chapter_done') {
        const label = chapterLabelRef.current(data.chapter_id)
        const seconds = data.elapsed_ms != null ? (data.elapsed_ms / 1000).toFixed(1) : '?'
        const pending = data.pending ?? 0
        const warnings = data.warnings ?? 0
        setAnalysis((prev) => ({
          ...prev,
          phase: `${label} · 关系后处理完成 · ${seconds}s · 待确认 ${pending} · 警告 ${warnings}`,
        }))
        pushLog('info', `${label}关系后处理：${data.total ?? 0} 条 · ${seconds}s · 待确认 ${pending} · 警告 ${warnings}`)
        return
      }
      if (data.phase === 'reconcile_running' || data.phase === 'reconcile_waiting_model') {
        setAnalysis((prev) => ({ ...prev, phase: '总校对中…' }))
        if (data.phase === 'reconcile_running') pushLog('phase', '进入总校对（Reconcile）…')
        return
      }
      if (data.phase === 'factions_running') {
        setAnalysis((prev) => ({ ...prev, phase: '势力归纳中…' }))
        return
      }
      if (data.phase === 'extracting' || data.phase === 'analyzing') {
        setAnalysis((prev) => ({ ...prev, phase: '章节抽取中…' }))
        return
      }
      if (data.phase === 'waiting_failed') {
        setAnalysis((prev) => ({
          ...prev,
          phase: '等待处理失败章节…',
          failedChapterIds: data.failed_chapters ?? prev.failedChapterIds,
          awaitingFailureDecision: true,
        }))
        return
      }
      if (data.phase === 'retrying_failed') {
        setAnalysis((prev) => ({ ...prev, phase: '正在重试失败章节…', awaitingFailureDecision: false }))
        return
      }
      if (data.phase === 'failed_skipped') {
        setAnalysis((prev) => ({ ...prev, phase: '已跳过失败章节，继续后处理…', awaitingFailureDecision: false }))
        return
      }
      const label = chapterLabelRef.current(data.chapter_id)
      if (data.total != null || data.done != null) {
        setAnalysis((prev) => ({
          ...prev,
          total: data.total ?? prev.total,
          done: data.done ?? prev.done,
        }))
      }
      if (data.chapter_id != null) {
        setAnalysis((prev) => {
          const failed = new Set(prev.failedChapterIds)
          if (data.status === 'failed') failed.add(data.chapter_id!)
          if (data.status === 'done' || data.status === 'partial') failed.delete(data.chapter_id!)
          return { ...prev, failedChapterIds: [...failed].sort((a, b) => a - b) }
        })
        if (data.status === 'failed') {
          pushLog(
            'fail',
            `「${label}」失败${data.error ? `：${data.error}` : ''}`,
          )
        } else if (data.status === 'partial') {
          pushLog('info', `「${label}」仅部分完成，建议重跑`)
        } else {
          pushLog(
            'ok',
            `「${label}」完成 (${data.done ?? '?'}/${data.total ?? '?'})`,
          )
        }
      }
    },
    [pushLog],
  )

  const handleDone = useCallback(
    async (data: DoneEvent) => {
      unsubRef.current = null
      subscribedBookRef.current = ''
      const failed = data.chapters_failed ?? 0
      const done = data.chapters_done ?? 0
      const status = data.status || data.phase || 'done'

      setAnalysis((prev) => ({
        ...prev,
        running: false,
        phase: '',
        successCount: done,
        failureCount: failed,
        runningCount: 0,
        queuedCount: 0,
        awaitingFailureDecision: false,
      }))

      if (data.error === 'no analysis running') {
        pushLog('fail', '没有进行中的分析（SSE 未挂上编排器）')
        onBannerRef.current('没有进行中的分析', '')
        return
      }

      if (data.errors?.length) {
        for (const err of data.errors) {
          pushLog(
            'fail',
            `「${chapterLabelRef.current(err.chapter_id)}」：${err.error}`,
          )
        }
      }

      if (failed > 0 || status === 'failed') {
        const summary =
          `分析结束：成功 ${done} 章 · 失败 ${failed} 章` +
          (data.stopped ? ' · 已中断' : '') +
          (status ? ` · status=${status}` : '')
        pushLog('fail', summary)
        onBannerRef.current(summary, '')
      } else if (status === 'partial' || data.chapters_partial_ids?.length) {
        const summary = `分析结束：${data.chapters_partial_ids?.length ?? 0} 章仅部分完成，请在章账本查看原因并重跑`
        pushLog('info', summary)
        onBannerRef.current('', summary)
      } else if (data.degraded || data.phase === 'reconcile_failed') {
        const summary = `章分析完成（${done}），总校对失败/降级，仍可出图`
        pushLog('info', summary)
        onBannerRef.current('', summary)
      } else {
        const summary = `分析完成：${done} 章 · 总校对 ${data.reconcile_done ? 'OK' : '跳过'}`
        pushLog('ok', summary)
        onBannerRef.current('', summary)
      }

      await onDoneRef.current()
    },
    [pushLog],
  )

  const resume = useCallback(
    async (bookId: string): Promise<boolean> => {
      if (!bookId) return false
      try {
        const task = await getAnalysisTask(bookId)
        if (!task.active) return false
        const processed = task.chapters.filter((c) =>
          ['done', 'partial', 'failed', 'skipped'].includes(c.status),
        ).length
        const successCount = task.chapters.filter((c) => ['done', 'partial'].includes(c.status)).length
        const failureCount = task.chapters.filter((c) => ['failed', 'skipped'].includes(c.status)).length
        const runningCount = task.chapters.filter((c) => c.status === 'running').length
        const queuedCount = task.chapters.filter((c) => ['pending', 'queued_retry'].includes(c.status)).length
        const phaseLabels: Record<string, string> = {
          starting: '启动中…',
          extracting: '章节抽取中…',
          waiting_failed: '等待处理失败章节…',
          relations_running: '关系归一化与验证中…',
          reconcile_running: '总校对中…',
          reconcile_waiting_model: '总校对中…',
          factions_running: '势力归纳中…',
        }
        setAnalysis((prev) => ({
          ...prev,
          running: true,
          total: task.total_chapters ?? task.chapters.length,
          done: processed,
          phase: phaseLabels[task.phase] ?? task.phase ?? '分析中…',
          successCount,
          failureCount,
          runningCount,
          queuedCount,
          failedChapterIds: task.chapters.filter((c) => c.status === 'failed').map((c) => c.chapter_id),
          awaitingFailureDecision: task.phase === 'waiting_failed',
        }))
        if (subscribedBookRef.current === bookId && unsubRef.current) return true
        unsubRef.current?.()
        subscribedBookRef.current = bookId
        unsubRef.current = subscribeAnalysisProgress(bookId, {
          onProgress: handleProgress,
          onDone: (d) => { void handleDone(d) },
          onError: (m) => pushLog('info', m),
        })
        return true
      } catch (e) {
        pushLog('fail', e instanceof Error ? e.message : String(e))
        return false
      }
    },
    [handleDone, handleProgress, pushLog],
  )

  const disconnect = useCallback(() => {
    unsubRef.current?.()
    unsubRef.current = null
    subscribedBookRef.current = ''
    logId.current = 0
    setAnalysis(emptyAnalysis())
  }, [])

  const start = useCallback(
    async (bookId: string, toChapter: number | ''): Promise<boolean> => {
      unsubRef.current?.()
      unsubRef.current = null
      setAnalysis({
        running: true,
        total: 0,
        done: 0,
        phase: '启动中…',
        logs: [],
        successCount: 0,
        failureCount: 0,
        runningCount: 0,
        queuedCount: 0,
        failedChapterIds: [],
        awaitingFailureDecision: false,
      })
      logId.current = 0

      try {
        const startResult = await startAnalysisApi(
          bookId,
          toChapter === '' ? undefined : toChapter,
        )
        const total = startResult.total_chapters ?? 0
        setAnalysis((prev) => ({
          ...prev,
          total,
          phase: total ? `并行分析 ${total} 章…` : '无待分析章节',
          queuedCount: total,
        }))
        const until =
          toChapter === ''
            ? '全书正文'
            : `截止「${chapterLabelRef.current(toChapter)}」`
        pushLog(
          'info',
          `已启动分析：${until}，队列 ${total} 章（mode=${startResult.mode ?? 'few_long'}）`,
        )

        if (total === 0) {
          setAnalysis((prev) => ({
            ...prev,
            running: false,
            phase: '无章可分析',
          }))
          onBannerRef.current(
            '没有可分析的章节（仅导读/附录，或 to_chapter 未覆盖任何 include_in_analysis 正文）',
            '',
          )
          return false
        }

        subscribedBookRef.current = bookId
        unsubRef.current = subscribeAnalysisProgress(bookId, {
          onProgress: handleProgress,
          onDone: (d) => {
            void handleDone(d)
          },
          onError: (m) => {
            pushLog('info', m)
          },
        })
        return true
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        setAnalysis((prev) => ({
          ...prev,
          running: false,
          phase: '启动失败',
        }))
        pushLog('fail', message)
        onBannerRef.current(message, '')
        return false
      }
    },
    [pushLog, handleProgress, handleDone],
  )

  const retryFailed = useCallback(
    async (bookId: string, chapterIds?: number[]) => {
      try {
        const res = await retryFailedChaptersApi(bookId, chapterIds)
        if (res.queued.length) {
          pushLog('info', `已加入重试队列：${res.queued.map((id) => chapterLabelRef.current(id)).join('、')}`)
          setAnalysis((prev) => ({ ...prev, awaitingFailureDecision: false, phase: '等待重试启动…' }))
        }
      } catch (e) {
        pushLog('fail', e instanceof Error ? e.message : String(e))
      }
    },
    [pushLog],
  )

  const skipFailed = useCallback(
    async (bookId: string) => {
      try {
        const res = await skipFailedChaptersApi(bookId)
        pushLog('info', `已跳过 ${res.chapters.length} 个失败章节，结果将标记为部分完成`)
        setAnalysis((prev) => ({ ...prev, awaitingFailureDecision: false, phase: '继续后处理…' }))
      } catch (e) {
        pushLog('fail', e instanceof Error ? e.message : String(e))
      }
    },
    [pushLog],
  )

  const stop = useCallback(
    async (bookId: string) => {
      try {
        await stopAnalysisApi(bookId)
        pushLog('info', '已请求停止；不会再调度新的模型请求，已发出的请求仍可能完成并计费')
        setAnalysis((prev) => ({ ...prev, phase: '停止中…' }))
      } catch (e) {
        pushLog('fail', e instanceof Error ? e.message : String(e))
      }
    },
    [pushLog],
  )

  // 卸载时清理 SSE
  useEffect(() => {
    return () => {
      unsubRef.current?.()
      subscribedBookRef.current = ''
    }
  }, [])

  return {
    analysis, start, stop, resume, retryFailed, skipFailed, disconnect,
    isRunning: analysis.running, pushLog,
  }
}
