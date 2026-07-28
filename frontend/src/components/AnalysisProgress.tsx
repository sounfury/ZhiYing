import type { AnalysisUi } from '../types'

interface AnalysisProgressProps {
  analysis: AnalysisUi
}

export function AnalysisProgress({ analysis }: AnalysisProgressProps) {
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