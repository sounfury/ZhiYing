import { useEffect, useRef, useState } from 'react'
import type { RelationTypeMeta } from '../api'

interface MoreFiltersMenuProps {
  minAppearance: number
  onMinAppearanceChange: (v: number) => void
  categoryFilter: string[]
  onCategoryFilterChange: (categories: string[]) => void
  typeFilter: string[]
  onTypeFilterChange: (types: string[]) => void
  relationTypes: RelationTypeMeta[]
}

/**
 * 不常动的过滤器收进弹层：出场下限、关系分类与具体类型。
 * 常驻控制条只会把图挤矮。
 */
export function MoreFiltersMenu({
  minAppearance,
  onMinAppearanceChange,
  categoryFilter,
  onCategoryFilterChange,
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
  if (categoryFilter.length) badges.push(`分类 ${categoryFilter.length}`)
  if (typeFilter.length) badges.push(`关系 ${typeFilter.length}`)
  const summary = badges.length ? badges.join(' · ') : '默认'

  const toggleType = (t: string) => {
    const next = typeFilter.includes(t)
      ? typeFilter.filter((x) => x !== t)
      : [...typeFilter, t]
    onTypeFilterChange(next)
  }

  const grouped = [...new Set(relationTypes.map((r) => r.category))].map((category) => ({
    category,
    items: relationTypes.filter((r) => r.category === category),
  }))

  return (
    <div className="more-filters" ref={wrapRef}>
      <span className="more-filters-label">筛选</span>
      <button
        type="button"
        className={`more-filters-btn${badges.length ? ' on' : ''}`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title="出场章数、关系分类与具体类型"
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

          <div className="type-filter">
            <div className="type-filter-head">
              <span>关系类型</span>
              {(typeFilter.length > 0 || categoryFilter.length > 0) && (
                <button type="button" onClick={() => { onTypeFilterChange([]); onCategoryFilterChange([]) }}>
                  全部
                </button>
              )}
            </div>
            <p className="hint">点分类按大类筛选，点具体关系按语义筛选；同时选择时取交集。</p>
            {grouped.map(
              (g) =>
                g.items.length > 0 && (
                  <div key={g.category} className="type-filter-group">
                    <button type="button" className={`type-chip${categoryFilter.includes(g.category) ? ' on' : ''}`}
                      onClick={() => onCategoryFilterChange(categoryFilter.includes(g.category)
                        ? categoryFilter.filter((c) => c !== g.category) : [...categoryFilter, g.category])}>
                      {g.category}
                    </button>
                    <div className="type-chips">
                      {g.items.map((r) => {
                        const on = typeFilter.includes(r.predicate)
                        return (
                          <button
                            key={r.predicate}
                            type="button"
                            className={`type-chip${on ? ' on' : ''}`}
                            onClick={() => toggleType(r.predicate)}
                            title={r.definition}
                          >
                            {r.label}
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
