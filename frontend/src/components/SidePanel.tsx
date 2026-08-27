import type { ReactNode } from 'react'
import type { SideTab } from '../types'

interface SidePanelProps {
  tab: SideTab
  onTab: (tab: SideTab) => void
  castCount?: number
  detail: ReactNode
  cast: ReactNode
  ledger: ReactNode
}

const TABS: { id: SideTab; label: string }[] = [
  { id: 'detail', label: '详情' },
  { id: 'cast', label: '人名册' },
  { id: 'ledger', label: '账本' },
]

/**
 * 侧栏：详情 / 人名册 / 账本 三个一等入口，仍是同一张工作台。
 */
export function SidePanel({ tab, onTab, castCount, detail, cast, ledger }: SidePanelProps) {
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
            {t.id === 'cast' && castCount != null && castCount > 0 && (
              <em>{castCount}</em>
            )}
          </button>
        ))}
      </nav>
      <div className="side-body">
        {tab === 'detail' && detail}
        {tab === 'cast' && cast}
        {tab === 'ledger' && ledger}
      </div>
    </aside>
  )
}
