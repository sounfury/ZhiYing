import { useCallback, useEffect, useRef, useState } from 'react'
import {
  startAnalysis as startAnalysisApi,
  stopAnalysis as stopAnalysisApi,
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
      if (data.phase === 'reconcile_running') {
        setAnalysis((prev) => ({ ...prev, phase: '总校对中…' }))
        pushLog('phase', '进入总校对（Reconcile）…')
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
    },
    [pushLog],
  )

  const handleDone = useCallback(
    async (data: DoneEvent) => {
      unsubRef.current = null
      const failed = data.chapters_failed ?? 0
      const done = data.chapters_done ?? 0
      const status = data.status || data.phase || 'done'

      setAnalysis((prev) => ({ ...prev, running: false, phase: '' }))

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

  const stop = useCallback(
    async (bookId: string) => {
      try {
        await stopAnalysisApi(bookId)
        pushLog('info', '已请求停止（运行中的章会跑完）')
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
    }
  }, [])

  return { analysis, start, stop, isRunning: analysis.running, pushLog }
}