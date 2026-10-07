/**
 * 侧栏外壳：「人物 / 人名册 / 章节」三个页签（人名册带人数徽标），
 * 章节聚焦时在顶部给出与图上一致的范围提示，并可一键回到全书。
 */
import type { ReactNode } from 'react'
import type { ChapterBrief, ChapterFocusParam } from '../api'
import { chapterShortNames } from '../chapterNames'
import type { SideTab } from '../types'

interface SidePanelProps {
  tab: SideTab
  onTab: (tab: SideTab) => void
  castCount?: number
  /** 当前图的章节聚焦范围（以后端返回为准）；null = 全书 */
  focus: ChapterFocusParam | null | undefined
  chapters: ChapterBrief[]
  onShowAll: () => void
  detail: ReactNode
  cast: ReactNode
  ledger: ReactNode
}

const TABS: { id: SideTab; label: string }[] = [
  { id: 'detail', label: '人物' },
  { id: 'cast', label: '人名册' },
  { id: 'ledger', label: '章节' },
]

/** 与图上章节条同一套章名 */
function scopeText(focus: ChapterFocusParam, chapters: ChapterBrief[]): string {
  const names = chapterShortNames(chapters)
  const idx = chapters.findIndex((c) => c.chapter_id === focus.chapter)
  const name = idx >= 0 ? names[idx] : `第 ${focus.chapter} 段`
  if (focus.mode === 'single') return `${name} · 只显示本章出场人物`
  return idx <= 0 ? `${name} · 只用这一章的信息出图` : `${names[0]} – ${name} · 只用这几章的信息出图`
}

export function SidePanel({ tab, onTab, castCount, focus, chapters, onShowAll, detail, cast, ledger }: SidePanelProps) {
  return (
    <aside className="side" id="detail-side">
      <nav className="side-tabs" aria-label="侧栏">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={tab === t.id ? 'on' : ''}
            onClick={() => onTab(t.id)}
            aria-current={tab === t.id ? 'page' : undefined}
          >
            {t.label}
            {t.id === 'cast' && castCount != null && castCount > 0 && <em>{castCount}</em>}
          </button>
        ))}
      </nav>
      {focus && (
        <div className="side-scope">
          <span className="side-scope-dot" aria-hidden="true" />
          <span className="side-scope-text">{scopeText(focus, chapters)}</span>
          <button type="button" className="text-link" onClick={onShowAll}>
            看全书
          </button>
        </div>
      )}
      <div className="side-body">
        {tab === 'detail' && detail}
        {tab === 'cast' && cast}
        {tab === 'ledger' && ledger}
      </div>
    </aside>
  )
}
