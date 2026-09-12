import type { ChapterBrief, ChapterLedger } from '../api'

interface LedgerPanelProps {
  chapters: ChapterBrief[]
  chapterId: number | ''
  onChapterChange: (id: number | '') => void
  ledger: ChapterLedger | null
  loading: boolean
  missing: boolean
  error: string
  rerunning: boolean
  disabled: boolean
  nameOf: (personId: string) => string
  onRerun: () => void
  onFocusPerson: (personId: string) => void
}

/**
 * 单章账本：摘要、人物、关系与证据。可重跑该章（覆盖 ledger，不级联）。
 */
export function LedgerPanel({
  chapters,
  chapterId,
  onChapterChange,
  ledger,
  loading,
  missing,
  error,
  rerunning,
  disabled,
  nameOf,
  onRerun,
  onFocusPerson,
}: LedgerPanelProps) {
  return (
    <div className="ledger-panel">
      <div className="ledger-toolbar">
        <label>
          章节
          <select
            value={chapterId === '' ? '' : String(chapterId)}
            disabled={disabled || !chapters.length}
            onChange={(e) =>
              onChapterChange(e.target.value === '' ? '' : Number(e.target.value))
            }
          >
            <option value="">选择一章…</option>
            {chapters.map((c) => (
              <option key={c.chapter_id} value={c.chapter_id}>
                {c.title || `章节 ${c.chapter_id}`}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="btn"
          disabled={disabled || rerunning || chapterId === ''}
          onClick={onRerun}
          title="覆盖该章账本，不级联后续章，也不跑总校对。需要 LLM。"
        >
          {rerunning ? '重跑中…' : '重跑此章'}
        </button>
      </div>

      {chapterId === '' && (
        <p className="hint">选一章查看它的账本：人物、关系、原句证据。</p>
      )}

      {chapterId !== '' && loading && <p className="hint">正在取这一章的账本…</p>}

      {error && <p className="hint cast-error">{error}</p>}

      {missing && !loading && (
        <p className="hint">此章尚未分析。启动分析或重跑之后，账本会出现在这里。</p>
      )}

      {ledger && !loading && (
        <>
          <p className="ledger-stats">
            {ledger.persons.length} 人 · {ledger.relations.length} 条关系
            {ledger.events.length ? ` · ${ledger.events.length} 则事件` : ''}
          </p>
          {ledger.analysis_status === 'partial' && <p className="hint">本章仅部分完成，建议重跑。</p>}
          {ledger.warnings?.map((warning, i) => <p className="hint" key={i}>{warning}</p>)}

          {ledger.summary && (
            <section className="ledger-block">
              <h3>章摘要</h3>
              <p className="ledger-summary">{ledger.summary}</p>
            </section>
          )}

          {ledger.persons.length > 0 && (
            <section className="ledger-block">
              <h3>出场</h3>
              <ul className="ledger-people">
                {ledger.persons.map((p) => (
                  <li key={p.person_id}>
                    <button type="button" onClick={() => onFocusPerson(p.person_id)}>
                      {nameOf(p.person_id)}
                    </button>
                    {p.aliases_in_chapter.length > 0 && (
                      <span>{p.aliases_in_chapter.join('、')}</span>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {ledger.relations.length > 0 && (
            <section className="ledger-block">
              <h3>关系</h3>
              {ledger.relations.map((rel) => (
                <div key={rel.relation_id} className="tag">
                  <div className="tag-head">
                    <strong>
                      <button type="button" className="linkish" onClick={() => onFocusPerson(rel.person_a)}>
                        {nameOf(rel.person_a)}
                      </button>
                      {rel.directed ? ' → ' : ' ↔ '}
                      <button type="button" className="linkish" onClick={() => onFocusPerson(rel.person_b)}>
                        {nameOf(rel.person_b)}
                      </button>
                      {' · '}
                      {rel.label}
                    </strong>
                    <span>
                      {rel.status === 'confirmed' ? '已确认' : rel.status === 'rejected' ? '已否定' : '待确认'}
                      {rel.directed ? ' · 有向' : ''}
                    </span>
                  </div>
                  <p className="hint">{rel.category} · {rel.subject_role} {rel.directed ? "→" : "↔"} {rel.object_role}</p>
                  <p>{rel.raw_relation}</p>
                  {rel.normalization_status === "pending" && <p className="hint">类型待归一化 · {rel.normalization_reason}</p>}
                  {rel.evidence.quote && (
                    <p className="ledger-quote">「{rel.evidence.quote}」</p>
                  )}
                  {rel.evidence.note && <p className="hint">{rel.evidence.note}</p>}
                  {rel.verification_reason && <p className="hint">{rel.verification_reason}</p>}
                </div>
              ))}
            </section>
          )}

          {ledger.events.length > 0 && (
            <section className="ledger-block">
              <h3>事件</h3>
              <ul className="ledger-events">
                {ledger.events.map((ev, i) => (
                  <li key={i}>
                    {ev.description}
                    {ev.persons.length > 0 && (
                      <span className="hint">
                        {' '}
                        ({ev.persons.map((id) => nameOf(id)).join('、')})
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  )
}
