import { useEffect, useRef, useState } from 'react'
import type { GraphFaction } from '../api'
import { FACTION_KIND_LABEL, factionColor } from '../factions'

interface FactionFilterProps {
  factions: GraphFaction[]
  /** 已选块；空数组 = 全部 */
  selected: string[]
  onChange: (ids: string[]) => void
  disabled?: boolean
}

/**
 * 势力多选筛选：只看某几块时，被选中的块会重新铺满整圈（等于块级下钻）。
 *
 * 用自定义下拉而不是 <select multiple>：后者在 macOS 上要按 cmd 点选，
 * 而这里最常用的操作是「勾两三块看它们怎么连」。
 */
export function FactionFilter({
  factions,
  selected,
  onChange,
  disabled,
}: FactionFilterProps) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  // 点外面关掉
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const allIds = factions.map((f) => f.faction_id)
  /** 空选 = 全部，这里展开成实际集合，勾选框的语义才直观 */
  const effective = selected.length ? selected : allIds

  const toggle = (id: string) => {
    const next = effective.includes(id)
      ? effective.filter((x) => x !== id)
      : [...effective, id]
    if (!next.length) return // 不允许全不选（空图没意义）
    onChange(next.length === allIds.length ? [] : next)
  }

  const summary = !selected.length
    ? `全部 ${factions.length} 块`
    : selected.length === 1
      ? (factions.find((f) => f.faction_id === selected[0])?.name ?? '1 块')
      : `已选 ${selected.length} 块`

  return (
    // 外层刻意用 div 而非 label：label 会把点击代理到内部第一个可标注控件
    // （那个下拉按钮），勾选块时就会连带开关下拉。
    <div className="faction-filter" ref={wrapRef}>
      <span className="faction-filter-label">势力筛选</span>
      <button
        type="button"
        className="faction-filter-btn"
        disabled={disabled || !factions.length}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title="只看勾选的势力块；不勾 = 全部"
      >
        <span>{factions.length ? summary : '（无势力册）'}</span>
        <i aria-hidden>{open ? '▴' : '▾'}</i>
      </button>

      {open && factions.length > 0 && (
        <div className="faction-filter-pop">
          <div className="faction-filter-ops">
            <button type="button" onClick={() => onChange([])}>
              重置为全部
            </button>
          </div>
          {factions.map((f) => (
            <label key={f.faction_id} className="faction-filter-row">
              <input
                type="checkbox"
                checked={effective.includes(f.faction_id)}
                onChange={() => toggle(f.faction_id)}
              />
              <i style={{ background: factionColor(f) }} />
              <span>{f.name}</span>
              <em>{FACTION_KIND_LABEL[f.kind] ?? f.kind}</em>
              <b>{f.member_ids.length}</b>
            </label>
          ))}
        </div>
      )}
    </div>
  )
}
