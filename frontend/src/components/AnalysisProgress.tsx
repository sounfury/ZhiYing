import type { AnalysisUi } from '../types'

interface AnalysisProgressProps {
  analysis: AnalysisUi
  onRetryChapter: (chapterId: number) => void
  onRetryFailed: () => void
  onSkipFailed: () => void
}

export function AnalysisProgress({ analysis, onRetryChapter, onRetryFailed, onSkipFailed }: AnalysisProgressProps) {
  if (!analysis.running && analysis.logs.length === 0) return null

  const pct =
    analysis.total > 0
      ? Math.min(100, Math.round((analysis.done / analysis.total) * 100))
      : analysis.running
        ? 5
        : 0

  return (
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
      <div className="progress-counts" aria-label="章节任务计数">
        <span>成功 {analysis.successCount}</span>
        <span>失败 {analysis.failureCount}</span>
        <span>运行 {analysis.runningCount}</span>
        <span>排队 {analysis.queuedCount}</span>
      </div>
      {analysis.awaitingFailureDecision && analysis.failedChapterIds.length > 0 && (
        <div className="progress-actions">
          <span>失败章节：{analysis.failedChapterIds.join('、')}</span>
          {analysis.failedChapterIds.map((chapterId) => (
            <button
              key={chapterId}
              type="button"
              className="btn"
              onClick={() => onRetryChapter(chapterId)}
            >
              重试第 {chapterId} 章
            </button>
          ))}
          {analysis.failedChapterIds.length > 1 && (
            <button type="button" className="btn" onClick={onRetryFailed}>重试全部失败章</button>
          )}
          <button type="button" className="btn" onClick={onSkipFailed}>跳过并继续</button>
        </div>
      )}
      <ul className="progress-log">
        {analysis.logs.map((line) => (
          <li key={line.id} className={`log-${line.kind}`}>
            {line.text}
          </li>
        ))}
      </ul>
    </section>
  )
}