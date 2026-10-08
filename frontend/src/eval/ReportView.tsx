/**
 * 评测报告：左栏选「总览」或某一章（每章标出问题数），右栏只显示选中的一项；窄屏时左栏变为下拉框。
 */
import { Overview } from './Overview'
import { ChapterView } from './ChapterView'
import { chapterProblems, isSatisfied } from './report'
import type { EvalRun } from './evalApi'

/** 右栏显示的内容：总览，或第几章 */
export type Pane = 'overview' | number

type Props = {
  run: EvalRun
  previous: EvalRun | null
  typeNames: Map<string, string>
  pane: Pane
  onPane: (pane: Pane) => void
}

export function ReportView({ run, previous, typeNames, pane, onPane }: Props) {
  const chapters = run.report.chapters
  const current = pane === 'overview' ? null : (chapters.find((c) => c.number === pane) ?? null)
  const typeLabel = (id: string) => typeNames.get(id) ?? id

  return (
    <div className="rv">
      <nav className="rv-nav" aria-label="报告目录">
        <select
          className="rv-nav-select"
          value={current ? String(current.number) : 'overview'}
          onChange={(e) => onPane(e.target.value === 'overview' ? 'overview' : Number(e.target.value))}
        >
          <option value="overview">总览（{run.report.score.toFixed(1)} 分）</option>
          {chapters.map((c) => {
            const n = chapterProblems(c)
            return (
              <option key={c.number} value={c.number}>
                第 {c.number} 章 {c.title}
                {n ? `（${n} 个问题）` : ''}
              </option>
            )
          })}
        </select>

        <ul className="rv-nav-list">
          <li>
            <button type="button" className={current ? '' : 'on'} onClick={() => onPane('overview')}>
              <span>总览</span>
              <span className="rv-nav-score">{run.report.score.toFixed(1)}</span>
            </button>
          </li>
          {chapters.map((c) => {
            const n = chapterProblems(c)
            const hits = c.required.filter(isSatisfied).length
            return (
              <li key={c.number}>
                <button type="button" className={current?.number === c.number ? 'on' : ''} onClick={() => onPane(c.number)}>
                  <span className="rv-nav-title">
                    <span className="hint">第 {c.number} 章</span> {c.title}
                  </span>
                  {n ? <span className="rv-badge err">{n}</span> : <span className="rv-badge ok">✓</span>}
                  <span className="rv-nav-sub hint">
                    必有 {hits}/{c.required.length}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      </nav>

      <div className="rv-pane">
        {current ? (
          <ChapterView key={current.number} chapter={current} typeLabel={typeLabel} />
        ) : (
          <Overview run={run} previous={previous} onPane={onPane} />
        )}
      </div>
    </div>
  )
}
