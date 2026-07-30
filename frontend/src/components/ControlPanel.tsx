import type { BookMeta, ChapterBrief, GraphFaction } from '../api'
import type { LayoutMode } from '../GraphView'
import { FactionFilter } from './FactionFilter'
import { MoreFiltersMenu } from './MoreFiltersMenu'

interface ControlPanelProps {
  // Book selection
  books: BookMeta[]
  bookId: string
  selectedBook?: BookMeta
  onBookChange: (bookId: string) => void

  // Chapter filter
  contentChapters: ChapterBrief[]
  toChapter: number | ''
  singleChapterOnly: boolean
  onToChapterChange: (v: number | '') => void
  onSingleChapterOnlyChange: (v: boolean) => void

  // Graph filters
  minAppearance: number
  onMinAppearanceChange: (v: number) => void
  includeSuppressed: boolean
  onIncludeSuppressedChange: (v: boolean) => void

  // Layout
  layoutMode: LayoutMode
  onLayoutModeChange: (v: LayoutMode) => void
  factions: GraphFaction[]
  selectedFactions: string[]
  onSelectedFactionsChange: (ids: string[]) => void

  // Status
  isRunning: boolean
}

export function ControlPanel({
  books,
  bookId,
  selectedBook,
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
  layoutMode,
  onLayoutModeChange,
  factions,
  selectedFactions,
  onSelectedFactionsChange,
  isRunning,
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
          {!books.length && <option value="">（无书）</option>}
          {books.map((b) => (
            <option key={b.book_id} value={b.book_id}>
              [{b.status}] {b.title.slice(0, 48)}
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
          title="仅列出 include_in_analysis 的正文卷；导读/年表不出现"
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

      <MoreFiltersMenu
        minAppearance={minAppearance}
        onMinAppearanceChange={onMinAppearanceChange}
        includeSuppressed={includeSuppressed}
        onIncludeSuppressedChange={onIncludeSuppressedChange}
      />

      {layoutMode === 'faction' && (
        <FactionFilter
          factions={factions}
          selected={selectedFactions}
          onChange={onSelectedFactionsChange}
          disabled={isRunning}
        />
      )}

      {selectedBook && (
        <span className="meta">
          {selectedBook.author || '未知作者'} · {selectedBook.total_chapters} 章 ·{' '}
          {selectedBook.status}
        </span>
      )}
    </section>
  )
}