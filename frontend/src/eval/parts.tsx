/** 评测报告的小部件：差值标记、单条关系记录（可展开看依据与原文）。 */
import type { RecordView } from './evalApi'
import { verdictLabel } from './format'

export function Delta({ value, digits, unit = '' }: { value: number; digits: number; unit?: string }) {
  if (Math.abs(value) < 10 ** -digits / 2) return null
  return (
    <span className={`rv-delta ${value > 0 ? 'up' : 'down'}`}>
      {value > 0 ? '+' : ''}
      {value.toFixed(digits)}
      {unit}
    </span>
  )
}

export function RecordLine({ record: r }: { record: RecordView }) {
  const quotes = r.evidence.flatMap((e) => e.quotes).filter(Boolean)
  return (
    <details className={`rv-record${r.admitted ? '' : ' withheld'}`}>
      <summary>
        {r.person_a} {r.directed ? '→' : '—'} {r.person_b} · <b>{r.type_name}</b>
        {!r.admitted && <span className="rv-tag warn">{verdictLabel(r.verdict)}，未上图</span>}
      </summary>
      <div className="rv-record-body">
        <div>判断依据：{r.basis}</div>
        {r.evidence.map((e, i) => (
          <div key={i} className="hint">
            说明：{e.note}
          </div>
        ))}
        {quotes.map((q, i) => (
          <blockquote key={i}>{q}</blockquote>
        ))}
      </div>
    </details>
  )
}
