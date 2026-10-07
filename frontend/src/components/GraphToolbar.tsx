/**
 * 图上的悬浮工具：左上章节聚焦卡（全书 / 单章 / 前 N 章），右上竖排图标工具（布局切换、筛选、放大、缩小、适应窗口），
 * 筛选浮层（关系强度、关系类型、路人阈值、势力块）。
 * 只持有浮层开合等纯 UI 状态，筛选值全部由上层传入并回调修改。
 */
import { useEffect, useRef, useState } from 'react'
import type { ChapterBrief, GraphFaction, RelationTypeMeta } from '../api'
import type { ChapterFocusState } from '../types'
import type { LayoutMode } from './GraphView'
import { ChapterFocusBar } from './ChapterFocusBar'
import { MoreFiltersMenu } from './MoreFiltersMenu'

export interface GraphToolbarProps {
  /** 正文章节（按阅读顺序），章节聚焦只在这些章之间切换 */
  contentChapters: ChapterBrief[]
  chapterFocus: ChapterFocusState
  onChapterFocusChange: (v: ChapterFocusState) => void

  layoutMode: LayoutMode
  onLayoutModeChange: (v: LayoutMode) => void
  /** 当前图里的势力块 */
  factions: GraphFaction[]
  /** 只看这些势力块；空数组 = 全部 */
  selectedFactions: string[]
  onSelectedFactionsChange: (ids: string[]) => void

  /** 路人过滤：至少出场 N 章 */
  minAppearance: number
  onMinAppearanceChange: (v: number) => void
  /** 关系分类筛选（硬 / 中 / 软关系等）；空数组 = 不过滤 */
  categoryFilter: string[]
  onCategoryFilterChange: (v: string[]) => void
  /** 具体关系类型筛选；空数组 = 不过滤 */
  typeFilter: string[]
  onTypeFilterChange: (v: string[]) => void
  relationTypes: RelationTypeMeta[]
  /** 被路人过滤隐藏的人数（graph.filtered_count），无图时为 0 */
  filteredCount: number

  /** 让图重新适应窗口 */
  onRefit: () => void
  /** 分析进行中：所有控件禁用 */
  isRunning: boolean

  /** 放大 / 缩小；不传则不显示这两个按钮 */
  onZoom?: (kind: 'in' | 'out') => void
  /** 单章模式下本章入图人数，显示在章节说明里 */
  chapterPeopleCount?: number
  /** 当前有图可操作（无图时缩放 / 适应窗口禁用） */
  hasGraph?: boolean
}

const Icon = {
  faction: (
    <svg viewBox="0 0 20 20" aria-hidden>
      <rect x="2.5" y="3" width="7" height="6" rx="2" />
      <rect x="11.5" y="3" width="6" height="8" rx="2" />
      <rect x="2.5" y="11" width="9" height="6" rx="2" />
    </svg>
  ),
  affinity: (
    <svg viewBox="0 0 20 20" aria-hidden>
      <circle cx="10" cy="10" r="2.2" />
      <circle cx="10" cy="10" r="5.2" />
      <circle cx="10" cy="10" r="8" strokeDasharray="2 2.4" />
    </svg>
  ),
  filter: (
    <svg viewBox="0 0 20 20" aria-hidden>
      <path d="M3 4.5h14l-5.3 6.2v4.6l-3.4 1.6v-6.2z" strokeLinejoin="round" />
    </svg>
  ),
  plus: (
    <svg viewBox="0 0 20 20" aria-hidden>
      <path d="M10 4.5v11M4.5 10h11" />
    </svg>
  ),
  minus: (
    <svg viewBox="0 0 20 20" aria-hidden>
      <path d="M4.5 10h11" />
    </svg>
  ),
  fit: (
    <svg viewBox="0 0 20 20" aria-hidden>
      <path d="M3.5 7.5v-4h4M16.5 7.5v-4h-4M3.5 12.5v4h4M16.5 12.5v4h-4" strokeLinejoin="round" />
    </svg>
  ),
}

export function GraphToolbar({
  contentChapters,
  chapterFocus,
  onChapterFocusChange,
  layoutMode,
  onLayoutModeChange,
  factions,
  selectedFactions,
  onSelectedFactionsChange,
  minAppearance,
  onMinAppearanceChange,
  categoryFilter,
  onCategoryFilterChange,
  typeFilter,
  onTypeFilterChange,
  relationTypes,
  filteredCount,
  onRefit,
  isRunning,
  onZoom,
  chapterPeopleCount,
  hasGraph = true,
}: GraphToolbarProps) {
  const [filterOpen, setFilterOpen] = useState(false)
  const toolsRef = useRef<HTMLDivElement>(null)
  const popRef = useRef<HTMLDivElement>(null)

  // 点浮层与工具条以外的地方、或按 Esc 关掉浮层
  useEffect(() => {
    if (!filterOpen) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (popRef.current?.contains(t) || toolsRef.current?.contains(t)) return
      setFilterOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFilterOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [filterOpen])

  const filtering =
    categoryFilter.length > 0 || typeFilter.length > 0 || selectedFactions.length > 0 || minAppearance !== 2
  const nextLayout: LayoutMode = layoutMode === 'faction' ? 'affinity' : 'faction'
  const layoutTitle =
    layoutMode === 'faction' ? '布局：势力分区（点击切到亲疏扇区）' : '布局：亲疏扇区（点击切回势力分区）'

  return (
    <>
      <div className="float fx-chapter">
        <ChapterFocusBar
          chapters={contentChapters}
          focus={chapterFocus}
          onChange={onChapterFocusChange}
          disabled={isRunning}
          peopleCount={chapterPeopleCount}
        />
      </div>

      <div className="float fx-tools" role="toolbar" aria-label="图工具" ref={toolsRef}>
        <button
          type="button"
          className={layoutMode === 'affinity' ? 'on' : ''}
          title={layoutTitle}
          aria-label={layoutTitle}
          disabled={isRunning}
          onClick={() => onLayoutModeChange(nextLayout)}
        >
          {layoutMode === 'faction' ? Icon.faction : Icon.affinity}
        </button>
        <button
          type="button"
          className={filterOpen ? 'on' : ''}
          title={filtering ? '筛选（已调整）' : '筛选'}
          aria-label="筛选"
          aria-expanded={filterOpen}
          disabled={isRunning}
          onClick={() => setFilterOpen((v) => !v)}
        >
          {Icon.filter}
          {filtering && <i className="badge" aria-hidden />}
        </button>
        <hr />
        {onZoom && (
          <>
            <button type="button" title="放大" aria-label="放大" disabled={!hasGraph} onClick={() => onZoom('in')}>
              {Icon.plus}
            </button>
            <button type="button" title="缩小" aria-label="缩小" disabled={!hasGraph} onClick={() => onZoom('out')}>
              {Icon.minus}
            </button>
          </>
        )}
        <button type="button" title="适应窗口" aria-label="适应窗口" disabled={!hasGraph} onClick={onRefit}>
          {Icon.fit}
        </button>
      </div>

      {filterOpen && (
        <div className="float filterpop" ref={popRef} role="dialog" aria-label="筛选">
          <MoreFiltersMenu
            minAppearance={minAppearance}
            onMinAppearanceChange={onMinAppearanceChange}
            maxAppearance={Math.min(Math.max(contentChapters.length, 2), 30)}
            filteredCount={filteredCount}
            singleChapter={chapterFocus.mode === 'single'}
            categoryFilter={categoryFilter}
            onCategoryFilterChange={onCategoryFilterChange}
            typeFilter={typeFilter}
            onTypeFilterChange={onTypeFilterChange}
            relationTypes={relationTypes}
            factions={layoutMode === 'faction' ? factions : null}
            selectedFactions={selectedFactions}
            onSelectedFactionsChange={onSelectedFactionsChange}
            disabled={isRunning}
          />
        </div>
      )}
    </>
  )
}
