import { useEffect, useRef, useState } from 'react'
import type { RelationTypeMeta } from '../api'
import { TIER_LABEL } from '../labels'

interface MoreFiltersMenuProps {
  minAppearance: number
  onMinAppearanceChange: (v: number) => void
  includeSuppressed: boolean
  onIncludeSuppressedChange: (v: boolean) => void
  typeFilter: string[]
  onTypeFilterChange: (types: string[]) => void
  relationTypes: RelationTypeMeta[]
}

/**
 * 不常动的过滤器收进弹层：出场下限、被压制 soft、关系类型。
 * 常驻控制条只会把图挤矮。
 */
export function MoreFiltersMenu({
  minAppearance,
  onMinAppearanceChange,
  includeSuppressed,
  onIncludeSuppressedChange,
  typeFilter,
  onTypeFilterChange,
  relationTypes,
}: MoreFiltersMenuProps) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const badges: string[] = []
  if (minAppearance !== 1) badges.push(`min≥${minAppearance}`)
  if (includeSuppressed) badges.push('含压制')
  if (typeFilter.length) badges.push(`关系 ${typeFilter.length}`)
  const summary = badges.length ? badges.join(' · ') : '默认'

  const toggleType = (t: string) => {
    const next = typeFilter.includes(t)
      ? typeFilter.filter((x) => x !== t)
      : [...typeFilter, t]
    onTypeFilterChange(next)
  }

  const grouped = ['hard', 'mid', 'soft'].map((tier) => ({
    tier,
    items: relationTypes.filter((r) => r.tier === tier),
  }))

  return (
    <div className="more-filters" ref={wrapRef}>
      <span className="more-filters-label">筛选</span>
      <button
        type="button"
        className={`more-filters-btn${badges.length ? ' on' : ''}`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title="出场章数、被压制关系、关系类型"
      >
        <span>{summary}</span>
        <i aria-hidden>{open ? '▴' : '▾'}</i>
      </button>

      {open && (
        <div className="more-filters-pop">
          <label className="more-filters-row">
            最少出场章数
            <input
              type="number"
              min={0}
              max={20}
              value={minAppearance}
              onChange={(e) => onMinAppearanceChange(Number(e.target.value) || 0)}
            />
          </label>

          <label className="more-filters-row check">
            <input
              type="checkbox"
              checked={includeSuppressed}
              onChange={(e) => onIncludeSuppressedChange(e.target.checked)}
            />
            显示被压制的软关系
          </label>

          <div className="type-filter">
            <div className="type-filter-head">
              <span>关系类型</span>
              {typeFilter.length > 0 && (
                <button type="button" onClick={() => onTypeFilterChange([])}>
                  全部
                </button>
              )}
            </div>
            <p className="hint">不选 = 全部画出。点选只保留这些类型。</p>
            {grouped.map(
              (g) =>
                g.items.length > 0 && (
                  <div key={g.tier} className="type-filter-group">
                    <span>{TIER_LABEL[g.tier] ?? g.tier}</span>
                    <div className="type-chips">
                      {g.items.map((r) => {
                        const on = typeFilter.includes(r.type)
                        return (
                          <button
                            key={r.type}
                            type="button"
                            className={`type-chip${on ? ' on' : ''}`}
                            onClick={() => toggleType(r.type)}
                            title={r.directed ? '有向' : '无向'}
                          >
                            {r.type}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                ),
            )}
          </div>
        </div>
      )}
    </div>
  )
}
