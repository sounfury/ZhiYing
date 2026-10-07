/**
 * 筛选浮层里的「势力」一节：勾选只看哪几个势力块（块级下钻，PRD §5.7.5 D），空选 = 全部。
 * 势力多时列表自身滚动；不允许全不选（空图没有意义）。
 */
import type { GraphFaction } from '../api'
import { FACTION_KIND_LABEL, factionColor } from '../factions'

interface FactionFilterProps {
  factions: GraphFaction[]
  /** 已选块；空数组 = 全部 */
  selected: string[]
  onChange: (ids: string[]) => void
  disabled?: boolean
}

export function FactionFilter({ factions, selected, onChange, disabled }: FactionFilterProps) {
  const allIds = factions.map((f) => f.faction_id)
  // 空选 = 全部，展开成实际集合，勾选框语义才直观
  const effective = selected.length ? selected : allIds

  const toggle = (id: string) => {
    const next = effective.includes(id) ? effective.filter((x) => x !== id) : [...effective, id]
    if (!next.length) return
    onChange(next.length === allIds.length ? [] : next)
  }

  return (
    <section className="fp-sec">
      <h5>
        势力 <span>{selected.length ? `已选 ${selected.length} / ${factions.length}` : `全部 ${factions.length} 块`}</span>
        {selected.length > 0 && (
          <button type="button" className="fp-reset" onClick={() => onChange([])} disabled={disabled}>
            全部
          </button>
        )}
      </h5>
      <div className="fp-factions">
        {factions.map((f) => (
          <label key={f.faction_id} className="fp-check" title={FACTION_KIND_LABEL[f.kind] ?? f.kind}>
            <input
              type="checkbox"
              checked={effective.includes(f.faction_id)}
              disabled={disabled}
              onChange={() => toggle(f.faction_id)}
            />
            <i className="dot" style={{ background: factionColor(f) }} />
            <span className="nm">{f.name}</span>
            <em>{f.member_ids.length}</em>
          </label>
        ))}
      </div>
    </section>
  )
}
