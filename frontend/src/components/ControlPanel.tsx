import type { BookMeta, ChapterBrief } from '../api'

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
        min_appearance
        <input
          type="number"
          min={0}
          max={20}
          value={minAppearance}
          onChange={(e) => onMinAppearanceChange(Number(e.target.value) || 0)}
        />
      </label>

      <label className="check">
        <input
          type="checkbox"
          checked={includeSuppressed}
          onChange={(e) => onIncludeSuppressedChange(e.target.checked)}
        />
        显示被压制 soft
      </label>

      {selectedBook && (
        <span className="meta">
          {selectedBook.author || '未知作者'} · {selectedBook.total_chapters} 章 ·{' '}
          {selectedBook.status}
        </span>
      )}
    </section>
  )
}