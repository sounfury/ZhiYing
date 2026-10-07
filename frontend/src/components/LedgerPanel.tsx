/**
 * 侧栏「章节」页签：每章一张卡（标题、字数、读取状态、章摘要），点卡片切到该章的单章视图；
 * 卡片进入可视区或展开时才按需取该章分析结果，展开后可看全文摘要与本章人物 / 关系 / 事件明细；
 * 「重读本章」触发单章重跑（PRD §5.8 保留能力），分析进行中禁用。
 */
import { useEffect, useRef, useState } from 'react'
import type { BookMeta, ChapterBrief, ChapterLedger } from '../api'
import type { LedgerEntry } from '../hooks/useLedger'
import { formatWords } from '../labels'
import type { ChapterFocusState } from '../types'

interface LedgerPanelProps {
  chapters: ChapterBrief[]
  progress: BookMeta['analysis_progress']
  focus: ChapterFocusState
  entries: Record<number, LedgerEntry>
  onRequest: (chapterId: number) => void
  rerunningChapterId: number | null
  /** 分析进行中：禁止重读 */
  disabled: boolean
  nameOf: (personId: string) => string
  onFocusChapter: (chapterId: number) => void
  onRerun: (chapterId: number) => void
  onFocusPerson: (personId: string) => void
}

export function LedgerPanel({
  chapters,
  progress,
  focus,
  entries,
  onRequest,
  rerunningChapterId,
  disabled,
  nameOf,
  onFocusChapter,
  onRerun,
  onFocusPerson,
}: LedgerPanelProps) {
  if (!chapters.length) return <p className="side-empty">还没有可分析的正文章节。</p>

  const statusOf = (id: number): { text: string; tone?: 'warn' | 'muted' } => {
    if (rerunningChapterId === id) return { text: '重读中', tone: 'warn' }
    if (progress?.chapters_failed?.includes(id)) return { text: '读取失败', tone: 'warn' }
    if (progress?.chapters_partial?.includes(id)) return { text: '部分完成', tone: 'warn' }
    if (progress?.chapters_done.includes(id)) return { text: '已读' }
    return { text: '未读', tone: 'muted' }
  }

  return (
    <div className="ledger-panel">
      {chapters.map((c, i) => (
        <ChapterCard
          key={c.chapter_id}
          chapter={c}
          index={i}
          status={statusOf(c.chapter_id)}
          current={focus.mode !== 'all' && focus.chapter === c.chapter_id}
          entry={entries[c.chapter_id]}
          onRequest={onRequest}
          rerunning={rerunningChapterId === c.chapter_id}
          rerunBlocked={disabled || rerunningChapterId != null}
          nameOf={nameOf}
          onFocusChapter={onFocusChapter}
          onRerun={onRerun}
          onFocusPerson={onFocusPerson}
        />
      ))}
    </div>
  )
}

function ChapterCard({
  chapter,
  index,
  status,
  current,
  entry,
  onRequest,
  rerunning,
  rerunBlocked,
  nameOf,
  onFocusChapter,
  onRerun,
  onFocusPerson,
}: {
  chapter: ChapterBrief
  index: number
  status: { text: string; tone?: 'warn' | 'muted' }
  current: boolean
  entry: LedgerEntry | undefined
  onRequest: (chapterId: number) => void
  rerunning: boolean
  rerunBlocked: boolean
  nameOf: (personId: string) => string
  onFocusChapter: (chapterId: number) => void
  onRerun: (chapterId: number) => void
  onFocusPerson: (personId: string) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const id = chapter.chapter_id

  // 进入可视区才取结果；取过后不再观察
  useEffect(() => {
    const el = ref.current
    if (!el || visible) return
    const io = new IntersectionObserver(
      (records) => {
        if (records.some((r) => r.isIntersecting)) {
          setVisible(true)
          io.disconnect()
        }
      },
      { rootMargin: '120px 0px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [visible])

  // 结果失效（重跑 / 重新分析后）时 entry 会被清空，可见或展开的卡片重新取
  useEffect(() => {
    if ((visible || expanded) && !entry) onRequest(id)
  }, [visible, expanded, entry, id, onRequest])

  const ledger = entry?.status === 'ok' ? entry.ledger : null
  const summary =
    entry?.status === 'ok'
      ? entry.ledger.summary || '（本章暂无摘要）'
      : entry?.status === 'missing'
        ? '本章尚未分析。'
        : entry?.status === 'error'
          ? `取结果失败：${entry.error}`
          : '正在取本章摘要…'

  return (
    <div
      ref={ref}
      className={`chap${current ? ' cur' : ''}`}
      role="button"
      tabIndex={0}
      title="在图上只看这一章"
      onClick={() => onFocusChapter(id)}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault()
          onFocusChapter(id)
        }
      }}
    >
      <h4>
        {chapter.title || `第 ${index + 1} 章`}
        <small>
          {formatWords(chapter.word_count)} ·{' '}
          <span className={status.tone ? `st-${status.tone}` : 'st-ok'}>{status.text}</span>
        </small>
      </h4>
      <p className={`chap-sum${expanded ? '' : ' clamp'}${ledger ? '' : ' muted'}`}>{summary}</p>

      {expanded && ledger && (
        // 明细区内的点击不切章
        <div className="chap-detail" onClick={(e) => e.stopPropagation()}>
          <ChapterDetail ledger={ledger} nameOf={nameOf} onFocusPerson={onFocusPerson} />
        </div>
      )}

      <div className="chap-foot">
        {ledger && (
          <button
            type="button"
            className="text-link"
            onClick={(e) => {
              e.stopPropagation()
              setExpanded((v) => !v)
            }}
          >
            {expanded ? '收起' : `展开 · ${ledger.persons.length} 人 · ${ledger.relations.length} 条关系`}
          </button>
        )}
        <span className="grow" />
        <button
          type="button"
          className="btn ghost sm"
          disabled={rerunBlocked}
          title={rerunBlocked && !rerunning ? '分析或重读进行中，稍后再试' : '重新读这一章，完成后自动更新全书结果'}
          onClick={(e) => {
            e.stopPropagation()
            onRerun(id)
          }}
        >
          {rerunning && <span className="spin" aria-hidden="true" />}
          {rerunning ? '重读中…' : '重读本章'}
        </button>
      </div>
    </div>
  )
}

/** 展开后的二级明细：本章人物、关系（含依据）、事件 */
function ChapterDetail({
  ledger,
  nameOf,
  onFocusPerson,
}: {
  ledger: ChapterLedger
  nameOf: (personId: string) => string
  onFocusPerson: (personId: string) => void
}) {
  // 新人物在本章内还没有全书 ID，图里查不到名字时用本章称呼
  const localNames = new Map(ledger.persons.map((p) => [p.person_id, p.name ?? p.person_id]))
  const displayName = (pid: string) => {
    const n = nameOf(pid)
    return n && n !== pid ? n : (localNames.get(pid) ?? n)
  }
  const relations = ledger.relations.filter((r) => r.status !== 'rejected')

  return (
    <>
      {ledger.analysis_status === 'partial' && <p className="side-note">本章仅部分完成，建议重读。</p>}
      {ledger.persons.length > 0 && (
        <section className="sec">
          <h3>
            出场 <span>{ledger.persons.length}</span>
          </h3>
          <div className="chips">
            {ledger.persons.map((p) => (
              <button
                key={p.person_id}
                type="button"
                className="chip as-btn"
                title={p.aliases_in_chapter.length ? `本章又称：${p.aliases_in_chapter.join('、')}` : undefined}
                onClick={() => onFocusPerson(p.person_id)}
              >
                {displayName(p.person_id)}
              </button>
            ))}
          </div>
        </section>
      )}
      {relations.length > 0 && (
        <section className="sec">
          <h3>
            关系 <span>{relations.length}</span>
          </h3>
          {relations.map((rel) => (
            <div key={rel.relation_id} className="ledger-rel">
              <div className="ledger-rel-head">
                <span className="nm">{displayName(rel.person_a)}</span>
                <span className="ledger-rel-type">
                  {rel.directed ? '→' : '—'} {rel.label} {rel.directed ? '→' : '—'}
                </span>
                <span className="nm">{displayName(rel.person_b)}</span>
                {rel.status === 'pending' && <span className="tag-past">待确认</span>}
              </div>
              {rel.evidence.quote && <p className="ev-quote">「{rel.evidence.quote}」</p>}
              {(rel.evidence.note || rel.raw_relation) && (
                <div className="ev-note">{rel.evidence.note || rel.raw_relation}</div>
              )}
            </div>
          ))}
        </section>
      )}
      {ledger.events.length > 0 && (
        <section className="sec">
          <h3>
            事件 <span>{ledger.events.length}</span>
          </h3>
          <ul className="chapter-notes">
            {ledger.events.map((ev, i) => (
              <li key={i}>{ev.description}</li>
            ))}
          </ul>
        </section>
      )}
    </>
  )
}
