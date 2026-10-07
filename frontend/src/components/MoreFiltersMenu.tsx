/**
 * 图上「筛选」浮层的内容：关系强度（硬 / 中 / 软 = 关系分类筛选）、具体关系类型多选、
 * 路人过滤阈值（PRD §5.7.7，单章视图不按出场章数过滤）、势力块筛选（势力分区布局时）。
 * 不持有筛选值，全部回调给上层；浮层开合由 GraphToolbar 管。
 */
import { useState } from 'react'
import type { GraphFaction, RelationTypeMeta } from '../api'
import { FactionFilter } from './FactionFilter'

const STRENGTHS = [
  { category: '硬关系', cls: 'hard', label: '硬关系', hint: '血缘、婚姻…' },
  { category: '中关系', cls: 'medium', label: '中关系', hint: '师生、挚友…' },
  { category: '软关系', cls: 'soft', label: '软关系', hint: '朋友、相识' },
]

interface MoreFiltersMenuProps {
  minAppearance: number
  onMinAppearanceChange: (v: number) => void
  /** 滑块上限（一般 = 正文章数） */
  maxAppearance: number
  /** 被路人过滤隐藏的人数 */
  filteredCount: number
  /** 单章视图：不按出场章数过滤路人 */
  singleChapter: boolean
  categoryFilter: string[]
  onCategoryFilterChange: (categories: string[]) => void
  typeFilter: string[]
  onTypeFilterChange: (types: string[]) => void
  relationTypes: RelationTypeMeta[]
  /** 势力块筛选：仅势力分区布局时显示 */
  factions: GraphFaction[] | null
  selectedFactions: string[]
  onSelectedFactionsChange: (ids: string[]) => void
  disabled?: boolean
}

/** 注册表里本书实际出现过的类型（旧接口缺计数时视为都出现过） */
function isUsed(t: RelationTypeMeta): boolean {
  const x = t as RelationTypeMeta & { fact_count?: number; occurrence_count?: number }
  if (x.fact_count == null && x.occurrence_count == null) return true
  return (x.fact_count ?? 0) > 0 || (x.occurrence_count ?? 0) > 0
}

export function MoreFiltersMenu({
  minAppearance,
  onMinAppearanceChange,
  maxAppearance,
  filteredCount,
  singleChapter,
  categoryFilter,
  onCategoryFilterChange,
  typeFilter,
  onTypeFilterChange,
  relationTypes,
  factions,
  selectedFactions,
  onSelectedFactionsChange,
  disabled,
}: MoreFiltersMenuProps) {
  const [showAllTypes, setShowAllTypes] = useState(false)

  const allCats = STRENGTHS.map((s) => s.category)
  const effectiveCats = categoryFilter.length ? categoryFilter : allCats
  const toggleCat = (c: string) => {
    const next = effectiveCats.includes(c) ? effectiveCats.filter((x) => x !== c) : [...effectiveCats, c]
    if (!next.length) return
    onCategoryFilterChange(next.length === allCats.length ? [] : next)
  }

  const toggleType = (p: string) =>
    onTypeFilterChange(typeFilter.includes(p) ? typeFilter.filter((x) => x !== p) : [...typeFilter, p])

  const shown = relationTypes.filter((t) => showAllTypes || isUsed(t) || typeFilter.includes(t.predicate))
  const hiddenTypes = relationTypes.length - shown.length
  const groups = STRENGTHS.map((s) => ({ ...s, items: shown.filter((t) => t.category === s.category) }))
  const others = shown.filter((t) => !allCats.includes(t.category))

  const chip = (t: RelationTypeMeta) => (
    <button
      key={t.predicate}
      type="button"
      className={`type-chip${typeFilter.includes(t.predicate) ? ' on' : ''}`}
      title={t.definition}
      disabled={disabled}
      onClick={() => toggleType(t.predicate)}
    >
      {t.label}
    </button>
  )

  return (
    <>
      <section className="fp-sec">
        <h5>关系强度</h5>
        {STRENGTHS.map((s) => (
          <label key={s.category} className="fp-check">
            <input
              type="checkbox"
              checked={effectiveCats.includes(s.category)}
              disabled={disabled}
              onChange={() => toggleCat(s.category)}
            />
            <span className={`hsym ${s.cls}`} />
            {s.label}
            <small>（{s.hint}）</small>
          </label>
        ))}
      </section>

      {relationTypes.length > 0 && (
        <section className="fp-sec">
          <h5>
            关系类型 <span>{typeFilter.length ? `只看 ${typeFilter.length} 种` : '不限'}</span>
            {typeFilter.length > 0 && (
              <button type="button" className="fp-reset" onClick={() => onTypeFilterChange([])} disabled={disabled}>
                清空
              </button>
            )}
          </h5>
          {[...groups, { category: '其他', cls: '', label: '其他', hint: '', items: others }].map(
            (g) =>
              g.items.length > 0 && (
                <div key={g.category} className="type-chips">
                  {g.cls && <span className={`hsym ${g.cls}`} title={g.label} />}
                  {g.items.map(chip)}
                </div>
              ),
          )}
          {(hiddenTypes > 0 || showAllTypes) && (
            <button type="button" className="text-link fp-more" onClick={() => setShowAllTypes((v) => !v)}>
              {showAllTypes ? '只看本书出现过的类型' : `还有 ${hiddenTypes} 种本书未出现的类型`}
            </button>
          )}
        </section>
      )}

      <section className="fp-sec">
        <h5>
          路人过滤 · 至少出场 <b>{minAppearance}</b> 章
        </h5>
        <input
          type="range"
          min={1}
          max={Math.max(maxAppearance, minAppearance, 2)}
          value={minAppearance}
          disabled={disabled || singleChapter}
          aria-label="至少出场章数"
          onChange={(e) => onMinAppearanceChange(Number(e.target.value))}
        />
        <div className="fp-note">
          {singleChapter
            ? '单章视图显示本章所有出场人物，不按出场章数过滤'
            : `已隐藏 ${filteredCount} 位路人 · 有硬关系的人不受影响`}
        </div>
      </section>

      {factions && factions.length > 0 && (
        <FactionFilter
          factions={factions}
          selected={selectedFactions}
          onChange={onSelectedFactionsChange}
          disabled={disabled}
        />
      )}
    </>
  )
}
