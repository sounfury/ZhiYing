import type { BookMeta, ChapterBrief, GraphFaction, RelationTypeMeta } from '../api'
import type { LayoutMode } from './GraphView'
import type { SideTab } from '../types'
import { FactionFilter } from './FactionFilter'
import { MoreFiltersMenu } from './MoreFiltersMenu'

interface ControlPanelProps {
  books: BookMeta[]
  bookId: string
  onBookChange: (bookId: string) => void

  contentChapters: ChapterBrief[]
  toChapter: number | ''
  singleChapterOnly: boolean
  onToChapterChange: (v: number | '') => void
  onSingleChapterOnlyChange: (v: boolean) => void

  minAppearance: number
  onMinAppearanceChange: (v: number) => void
  includeSuppressed: boolean
  onIncludeSuppressedChange: (v: boolean) => void
  typeFilter: string[]
  onTypeFilterChange: (types: string[]) => void
  relationTypes: RelationTypeMeta[]

  layoutMode: LayoutMode
  onLayoutModeChange: (v: LayoutMode) => void
  factions: GraphFaction[]
  selectedFactions: string[]
  onSelectedFactionsChange: (ids: string[]) => void

  isRunning: boolean
  graphLoading: boolean
  factionLoading: boolean
  onRefreshGraph: () => void
  onExtractFactions: () => void
  onOpenSide: (tab: SideTab) => void
}

export function ControlPanel({
  books,
  bookId,
  onBookChange,
  contentChapters,
  toChapter,
  singleChapterOnly,
  onToChapterChange,
  onSingleChapterOnlyChange,
  minAppearance,
  onMinAppearanceChange,
  includeSuppressed,
  onIncludeSuppressedChange,
  typeFilter,
  onTypeFilterChange,
  relationTypes,
  layoutMode,
  onLayoutModeChange,
  factions,
  selectedFactions,
  onSelectedFactionsChange,
  isRunning,
  graphLoading,
  factionLoading,
  onRefreshGraph,
  onExtractFactions,
  onOpenSide,
}: ControlPanelProps) {
  return (
    <section className="controls">
      <label>
        书籍
        <select
          value={bookId}
          disabled={isRunning}
          onChange={(e) => onBookChange(e.target.value)}
        >
          <option value="">（未选择）</option>
          {books.map((b) => (
            <option key={b.book_id} value={b.book_id}>
              {b.title.slice(0, 48)}
              {b.title.length > 48 ? '…' : ''}
            </option>
          ))}
        </select>
      </label>

      <label>
        截止章节
        <select
          disabled={isRunning || !bookId}
          value={toChapter === '' ? '' : String(toChapter)}
          onChange={(e) =>
            onToChapterChange(e.target.value === '' ? '' : Number(e.target.value))
          }
          title="仅列出正文卷；导读/年表不出现"
        >
          {!singleChapterOnly && <option value="">全部正文</option>}
          {contentChapters.map((c) => (
            <option key={c.chapter_id} value={c.chapter_id}>
              {c.title || `章节 ${c.chapter_id}`}
              {c.word_count ? ` · ${c.word_count}字` : ''}
            </option>
          ))}
        </select>
      </label>

      <label className="check">
        <input
          type="checkbox"
          disabled={isRunning || !bookId}
          checked={singleChapterOnly}
          onChange={(e) => {
            const on = e.target.checked
            onSingleChapterOnlyChange(on)
            if (on && toChapter === '' && contentChapters[0]) {
              onToChapterChange(contentChapters[0].chapter_id)
            }
          }}
        />
        仅该章
      </label>

      <label>
        布局
        <select
          value={layoutMode}
          onChange={(e) => onLayoutModeChange(e.target.value as LayoutMode)}
          title="势力分区适合百人级大图；亲疏扇区适合聚焦后的小图"
        >
          <option value="faction">
            势力分区{factions.length ? ` (${factions.length} 块)` : '（无势力册）'}
          </option>
          <option value="affinity">亲疏扇区</option>
        </select>
      </label>

      {layoutMode === 'faction' && (
        <FactionFilter
          factions={factions}
          selected={selectedFactions}
          onChange={onSelectedFactionsChange}
          disabled={isRunning}
        />
      )}

      <MoreFiltersMenu
        minAppearance={minAppearance}
        onMinAppearanceChange={onMinAppearanceChange}
        includeSuppressed={includeSuppressed}
        onIncludeSuppressedChange={onIncludeSuppressedChange}
        typeFilter={typeFilter}
        onTypeFilterChange={onTypeFilterChange}
        relationTypes={relationTypes}
      />

      <div className="control-links">
        <button type="button" className="text-link" onClick={() => onOpenSide('cast')}>
          人名册
        </button>
        <button type="button" className="text-link" onClick={() => onOpenSide('ledger')}>
          账本
        </button>
        <button
          type="button"
          className="text-link"
          disabled={!bookId || isRunning || factionLoading}
          onClick={() => void onExtractFactions()}
          title="用 LLM 把人物划成学校 / 教会 / 家族等团体块"
        >
          {factionLoading ? '归纳势力中…' : '抽取势力'}
        </button>
        <button
          type="button"
          className="text-link"
          disabled={!bookId || graphLoading || isRunning}
          onClick={() => void onRefreshGraph()}
        >
          {graphLoading ? '加载中…' : '刷新图'}
        </button>
      </div>
    </section>
  )
}
